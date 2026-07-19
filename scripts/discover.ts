/**
 * Runner for the schema discovery job.
 *
 * In production this is a cron: `npm run db:discover`, hourly. See
 * docs/deploy.md for the Railway cron definition and README §"Keeping the demo
 * alive" for how it doubles as the keepalive that stops Supabase's free tier
 * pausing the project after 7 idle days.
 */
import pg from 'pg';
import 'dotenv/config';
import { ownerUrlOrThrow } from '../src/config.js';
import { runDiscoveryForOrg } from '../src/registry/discovery.js';

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrlOrThrow() });
  await client.connect();

  try {
    const { rows: orgs } = await client.query<{ id: string; slug: string }>(
      'SELECT id, slug FROM organizations ORDER BY slug'
    );
    if (orgs.length === 0) {
      console.log('No organizations found. Run `npm run db:seed` first.');
      return;
    }

    console.log('Running schema discovery…\n');

    for (const org of orgs) {
      await client.query('BEGIN');
      try {
        await client.query("SELECT set_config('app.current_org_id', $1, true)", [org.id]);
        const r = await runDiscoveryForOrg(client, org);
        await client.query('COMMIT');

        console.log(`  ${r.orgSlug}`);
        console.log(`    events scanned      : ${r.eventsScanned}`);
        console.log(`    properties upserted : ${r.propertiesUpserted}`);
        if (r.eventsAutoRegistered.length)
          console.log(`    auto-registered     : ${r.eventsAutoRegistered.join(', ')}`);
        if (r.eventsDeactivated.length)
          console.log(`    deactivated (stale) : ${r.eventsDeactivated.join(', ')}`);
        if (r.typeConflicts.length)
          console.log(`    type conflicts      : ${r.typeConflicts.join(', ')}`);
        if (r.piiFlagged.length)
          console.log(`    PII flagged         : ${r.piiFlagged.join(', ')}`);
        console.log(`    registry version    : ${r.versionChanged ? 'CHANGED (context cache invalidated)' : 'unchanged'}`);
        console.log('');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log('✓ Discovery complete.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\n✗ Discovery failed:\n', err);
  process.exit(1);
});
