/**
 * Schema discovery job.
 *
 * Scans each org's raw event stream and keeps the registry honest:
 *
 *   1. Auto-registers event names that have started firing but are not in
 *      event_definitions, flagged `auto_registered` with no description. They
 *      appear in the data dictionary labelled `[undocumented]` so the model
 *      knows the name is all the information it has.
 *   2. Refreshes first_seen_at / last_seen_at / event_count_30d.
 *   3. Deactivates events that have not fired in 180 days, so a taxonomy that
 *      has been accreting since 2019 does not eat the context budget.
 *   4. Scans JSONB keys per event: infers a type, measures cardinality and
 *      occurrence rate, records sample values, and enumerates enum values when
 *      cardinality is low enough to be worth listing.
 *   5. Flags keys whose observed JSON type varies across rows.
 *   6. Flags keys that look like PII.
 *   7. Bumps registry_version so the context cache invalidates.
 *
 * THE ONE RULE: this job never writes to `description` on either registry
 * table. Human-written documentation sits on top of machine-observed structure
 * and outlives it. Every UPSERT below lists its update columns explicitly, and
 * `description` is absent from all of them — that is the enforcement, and
 * tests/discovery.test.ts asserts it by writing a description, re-running the
 * job, and checking it survived.
 *
 * Runs as OWNER (it writes). Loops orgs explicitly.
 */
import type { Client } from 'pg';
import { createHash } from 'node:crypto';

/** Cardinality at or below which we enumerate values instead of sampling. */
const ENUM_THRESHOLD = 12;
/** Events silent for longer than this are marked inactive. */
const INACTIVE_AFTER_DAYS = 180;
/** Keys must appear on at least this share of rows to be treated as required. */
const REQUIRED_THRESHOLD = 0.99;
/** Cap the per-event key scan so a pathological org cannot stall the job. */
const MAX_ROWS_SAMPLED_PER_EVENT = 20_000;

const PII_KEY_RE =
  /(^|_)(email|e_mail|phone|mobile|msisdn|address|addr|street|postcode|zip|pincode|ssn|aadhaar|pan|dob|birth|card|cvv|iban|account_no)(_|$)/i;

const PII_VALUE_RE =
  /^([^@\s]+@[^@\s]+\.[a-z]{2,}|[+]?[0-9][0-9()\-. ]{7,}[0-9])$/i;

export interface DiscoveryReport {
  orgSlug: string;
  eventsScanned: number;
  eventsAutoRegistered: string[];
  eventsDeactivated: string[];
  propertiesUpserted: number;
  typeConflicts: string[];
  piiFlagged: string[];
  versionChanged: boolean;
}

/**
 * Maps a JSONB type plus a value sample to one of our declared data types.
 * Timestamps are strings in JSON, so they are detected by shape — worth doing
 * because "is this a date column" is the single most common thing a model
 * needs to know about a property key.
 */
function inferType(jsonType: string, sample: string | null): string {
  if (jsonType === 'number') return 'number';
  if (jsonType === 'boolean') return 'boolean';
  if (jsonType === 'array') return 'array';
  if (jsonType === 'object') return 'object';
  if (jsonType === 'string' && sample && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})/.test(sample)) {
    return 'timestamp';
  }
  return 'string';
}

export async function runDiscoveryForOrg(
  client: Client,
  org: { id: string; slug: string }
): Promise<DiscoveryReport> {
  const report: DiscoveryReport = {
    orgSlug: org.slug,
    eventsScanned: 0,
    eventsAutoRegistered: [],
    eventsDeactivated: [],
    propertiesUpserted: 0,
    typeConflicts: [],
    piiFlagged: [],
    versionChanged: false,
  };

  const before = await currentVersionHash(client, org.id);

  // -----------------------------------------------------------------------
  // 1 + 2. Observed events -> registry.
  //
  // Clock-skewed rows are excluded from the seen-at bounds: a single event
  // stamped 2035 would otherwise pin last_seen_at into the future and keep a
  // dead event alive in the context forever.
  // -----------------------------------------------------------------------
  const { rows: observed } = await client.query<{
    event_name: string;
    first_seen: string;
    last_seen: string;
    count_30d: string;
    total: string;
  }>(
    `
    SELECT e.event_name,
           min(e.event_time) FILTER (WHERE NOT e.clock_skew_flag)::text AS first_seen,
           max(e.event_time) FILTER (WHERE NOT e.clock_skew_flag)::text AS last_seen,
           count(*) FILTER (WHERE e.event_time >= now() - interval '30 days'
                              AND NOT e.clock_skew_flag)::text          AS count_30d,
           count(*)::text                                                AS total
    FROM events e
    WHERE e.org_id = $1
    GROUP BY e.event_name
    ORDER BY e.event_name
    `,
    [org.id]
  );

  report.eventsScanned = observed.length;

  const { rows: knownRows } = await client.query<{ event_name: string }>(
    'SELECT event_name FROM event_definitions WHERE org_id = $1',
    [org.id]
  );
  const known = new Set(knownRows.map((r) => r.event_name));

  for (const ev of observed) {
    if (!known.has(ev.event_name)) {
      report.eventsAutoRegistered.push(ev.event_name);
    }
    await client.query(
      `
      INSERT INTO event_definitions
        (org_id, event_name, display_name, category, is_active, auto_registered,
         first_seen_at, last_seen_at, event_count_30d, updated_at)
      VALUES ($1, $2, NULL, 'uncategorised', true, true, $3, $4, $5, now())
      ON CONFLICT (org_id, event_name) DO UPDATE SET
        -- description, display_name, category, canonical_name and quality_note
        -- are ABSENT from this list on purpose: they are the human layer.
        first_seen_at   = LEAST(COALESCE(event_definitions.first_seen_at, EXCLUDED.first_seen_at),
                                EXCLUDED.first_seen_at),
        last_seen_at    = GREATEST(COALESCE(event_definitions.last_seen_at, EXCLUDED.last_seen_at),
                                   EXCLUDED.last_seen_at),
        event_count_30d = EXCLUDED.event_count_30d,
        is_active       = true,
        updated_at      = now()
      `,
      [org.id, ev.event_name, ev.first_seen, ev.last_seen, Number(ev.count_30d)]
    );
  }

  // -----------------------------------------------------------------------
  // 3. Prune events that stopped firing. Not deleted — deactivated, so
  //    historical queries against them still resolve and the human-written
  //    description is not lost.
  // -----------------------------------------------------------------------
  const { rows: deactivated } = await client.query<{ event_name: string }>(
    `
    UPDATE event_definitions
    SET is_active = false, updated_at = now()
    WHERE org_id = $1
      AND is_active
      AND last_seen_at IS NOT NULL
      AND last_seen_at < now() - make_interval(days => $2)
    RETURNING event_name
    `,
    [org.id, INACTIVE_AFTER_DAYS]
  );
  report.eventsDeactivated = deactivated.map((r) => r.event_name);

  // -----------------------------------------------------------------------
  // 4-6. Property scan, one event at a time.
  //
  // Per-event rather than one giant query so a single high-cardinality event
  // cannot blow up memory, and so the work is resumable in spirit.
  // -----------------------------------------------------------------------
  for (const ev of observed) {
    const { rows: props } = await client.query<{
      property_key: string;
      json_type: string;
      all_types: string[];
      distinct_count: string;
      occurrence_rate: string;
      samples: unknown[];
      enum_values: unknown[] | null;
      last_seen: string;
    }>(
      `
      WITH sampled AS (
        SELECT e.properties, e.event_time
        FROM events e
        WHERE e.org_id = $1 AND e.event_name = $2
        ORDER BY e.event_time DESC
        LIMIT $3
      ),
      total AS (SELECT count(*)::numeric AS n FROM sampled),
      kv AS (
        SELECT kv.key                       AS property_key,
               kv.value                     AS value,
               jsonb_typeof(kv.value)       AS json_type,
               s.event_time
        FROM sampled s
        CROSS JOIN LATERAL jsonb_each(s.properties) AS kv(key, value)
        WHERE jsonb_typeof(kv.value) <> 'null'
      )
      SELECT
        kv.property_key,
        -- The modal type, used as the declared data_type.
        (array_agg(kv.json_type ORDER BY kv.json_type))[1]      AS json_type,
        array_agg(DISTINCT kv.json_type)                        AS all_types,
        count(DISTINCT kv.value)::text                          AS distinct_count,
        round(count(*)::numeric / NULLIF((SELECT n FROM total), 0), 4)::text AS occurrence_rate,
        (array_agg(DISTINCT kv.value))[1:5]                     AS samples,
        CASE WHEN count(DISTINCT kv.value) <= $4
             THEN array_agg(DISTINCT kv.value)
             ELSE NULL END                                      AS enum_values,
        max(kv.event_time)::text                                AS last_seen
      FROM kv
      GROUP BY kv.property_key
      ORDER BY kv.property_key
      `,
      [org.id, ev.event_name, MAX_ROWS_SAMPLED_PER_EVENT, ENUM_THRESHOLD]
    );

    for (const p of props) {
      const distinct = Number(p.distinct_count);
      const rate = Number(p.occurrence_rate);
      const types = (p.all_types ?? []).filter(Boolean);
      const hasConflict = types.length > 1;

      const firstSample =
        typeof p.samples?.[0] === 'string' ? (p.samples[0] as string) : null;
      const dataType = hasConflict ? 'mixed' : inferType(p.json_type, firstSample);

      const looksPii =
        PII_KEY_RE.test(p.property_key) ||
        (p.samples ?? []).some((s) => typeof s === 'string' && PII_VALUE_RE.test(s));

      if (hasConflict) report.typeConflicts.push(`${ev.event_name}.${p.property_key}`);
      if (looksPii) report.piiFlagged.push(`${ev.event_name}.${p.property_key}`);

      // Values of PII-flagged keys are never persisted into the registry:
      // sample_values ends up in the data dictionary that gets shipped to the
      // model, and a sample containing a real customer email would put it
      // there permanently. The key is documented, the values are not.
      const samples = looksPii ? [] : (p.samples ?? []).slice(0, 5);
      const enums = looksPii ? null : p.enum_values;

      await client.query(
        `
        INSERT INTO event_property_definitions
          (org_id, event_name, property_key, data_type, observed_types, has_type_conflict,
           is_required, occurrence_rate, distinct_value_count, sample_values, enum_values,
           is_pii, last_seen_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,now())
        ON CONFLICT (org_id, event_name, property_key) DO UPDATE SET
          -- NOTE: description is absent here on purpose. See the header comment.
          data_type            = EXCLUDED.data_type,
          observed_types       = EXCLUDED.observed_types,
          has_type_conflict    = EXCLUDED.has_type_conflict,
          is_required          = EXCLUDED.is_required,
          occurrence_rate      = EXCLUDED.occurrence_rate,
          distinct_value_count = EXCLUDED.distinct_value_count,
          sample_values        = EXCLUDED.sample_values,
          enum_values          = EXCLUDED.enum_values,
          is_pii               = EXCLUDED.is_pii,
          last_seen_at         = EXCLUDED.last_seen_at,
          updated_at           = now()
        `,
        [
          org.id, ev.event_name, p.property_key, dataType, types, hasConflict,
          rate >= REQUIRED_THRESHOLD, rate, distinct,
          JSON.stringify(samples), enums ? JSON.stringify(enums) : null,
          looksPii, p.last_seen,
        ]
      );
      report.propertiesUpserted++;
    }

    // Keys that have disappeared from the stream are removed from the
    // registry, otherwise a property renamed two years ago keeps costing
    // context tokens forever.
    await client.query(
      `
      DELETE FROM event_property_definitions
      WHERE org_id = $1 AND event_name = $2
        AND property_key <> ALL($3::text[])
      `,
      [org.id, ev.event_name, props.map((p) => p.property_key)]
    );
  }

  // -----------------------------------------------------------------------
  // 7. Version bump.
  // -----------------------------------------------------------------------
  const after = await computeVersionHash(client, org.id);
  report.versionChanged = before !== after;

  await client.query(
    `INSERT INTO registry_version (org_id, version_hash, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (org_id) DO UPDATE SET version_hash = EXCLUDED.version_hash, updated_at = now()`,
    [org.id, after]
  );

  return report;
}

/**
 * Hashes exactly the registry facts the context payload renders — nothing
 * more.
 *
 * event_count_30d is deliberately EXCLUDED. It changes on every single
 * discovery run as the 30-day window slides, and including it would invalidate
 * the context cache constantly while changing nothing a model would answer
 * differently. Volume figures in the context are therefore approximate to the
 * last registry change, which is the correct trade: the cache exists to stop
 * the model re-learning the schema, and the schema is what must be fresh.
 */
async function computeVersionHash(client: Client, orgId: string): Promise<string> {
  const { rows } = await client.query<{ blob: string | null }>(
    `
    SELECT string_agg(x.line, E'\n' ORDER BY x.line) AS blob
    FROM (
      SELECT 'E|' || ed.event_name || '|' || COALESCE(ed.display_name, '') || '|' ||
             COALESCE(ed.description, '') || '|' || ed.category || '|' ||
             COALESCE(ed.canonical_name, '') || '|' || ed.is_active::text || '|' ||
             ed.auto_registered::text || '|' || COALESCE(ed.quality_note, '') AS line
      FROM event_definitions ed WHERE ed.org_id = $1
      UNION ALL
      SELECT 'P|' || pd.event_name || '|' || pd.property_key || '|' || pd.data_type || '|' ||
             COALESCE(pd.description, '') || '|' || pd.is_required::text || '|' ||
             pd.is_pii::text || '|' || pd.has_type_conflict::text || '|' ||
             COALESCE(pd.enum_values::text, '')
      FROM event_property_definitions pd WHERE pd.org_id = $1
      UNION ALL
      SELECT 'M|' || md.metric_key || '|' || md.display_name || '|' || md.description || '|' ||
             md.unit || '|' || COALESCE(md.notes, '') || '|' ||
             array_to_string(md.allowed_dimensions, ',')
      FROM metric_definitions md WHERE md.org_id = $1 OR md.org_id IS NULL
      UNION ALL
      SELECT 'O|' || o.name || '|' || o.reporting_timezone || '|' || o.default_currency
      FROM organizations o WHERE o.id = $1
    ) x
    `,
    [orgId]
  );
  return createHash('sha256').update(rows[0]?.blob ?? '').digest('hex').slice(0, 32);
}

async function currentVersionHash(client: Client, orgId: string): Promise<string | null> {
  const { rows } = await client.query<{ version_hash: string }>(
    'SELECT version_hash FROM registry_version WHERE org_id = $1',
    [orgId]
  );
  return rows[0]?.version_hash ?? null;
}
