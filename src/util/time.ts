/**
 * Timezone-aware date range resolution.
 *
 * THE RULE: timestamps are stored as timestamptz (UTC). Every boundary and
 * every bucket label is computed in the ORG'S reporting timezone. "Orders
 * yesterday" for a Jaipur client means 2026-07-19 00:00 IST to 2026-07-20
 * 00:00 IST, which is 2026-07-18 18:30 UTC to 2026-07-19 18:30 UTC. Using UTC
 * day boundaries would silently attribute five and a half hours of every
 * evening to the wrong day. The kind of error that looks like a small daily
 * wobble and is never noticed.
 *
 * The window is half-open: [from, to). Inclusive-both would double-count the
 * boundary instant when two ranges are compared side by side.
 */
import { McpToolError } from './errors.js';

export type Bucket = 'hour' | 'day' | 'week' | 'month';

export const VALID_BUCKETS: Bucket[] = ['hour', 'day', 'week', 'month'];

export interface ResolvedRange {
  /** UTC instants to bind into the query. */
  fromUtc: Date;
  toUtc: Date;
  /** Local wall-clock labels, for echoing back to the caller. */
  fromLocal: string;
  toLocal: string;
  bucket: Bucket;
  timezone: string;
  /** Human description of what was actually resolved. */
  description: string;
  /** True when the range runs to now, so the final bucket is incomplete. */
  includesPartialBucket: boolean;
}

/** Offset in minutes between UTC and `zone` at instant `at`. */
function offsetMinutes(zone: string, at: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second)
  );
  return (asUtc - at.getTime()) / 60000;
}

/** Local wall-clock parts of `at` in `zone`. */
function localParts(zone: string, at: Date) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second),
  };
}

/**
 * Converts a local wall-clock time in `zone` to a UTC instant.
 *
 * Two-pass because the offset depends on the instant we are trying to find
 * (DST). The second pass corrects the first pass's guess, which is exact
 * except for wall-clock times that do not exist (the spring-forward gap). * for those it lands on the instant the clock jumps to, which is the sane
 * interpretation of a range boundary.
 */
function localToUtc(
  zone: string,
  y: number, mo: number, d: number,
  h = 0, mi = 0, s = 0
): Date {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  const guess = new Date(naive - offsetMinutes(zone, new Date(naive)) * 60000);
  return new Date(naive - offsetMinutes(zone, guess) * 60000);
}

const fmtLocal = (zone: string, at: Date): string => {
  const p = localParts(zone, at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Relative keywords. These exist because a model asked "how many orders last
 * week" should not have to compute IST week boundaries itself. That is
 * exactly the kind of arithmetic it gets subtly wrong.
 *
 * Weeks start Monday, matching Postgres date_trunc('week').
 */
function resolveKeyword(
  keyword: string,
  zone: string,
  now: Date
): { from: Date; to: Date; label: string } | null {
  const p = localParts(zone, now);
  const startOfToday = localToUtc(zone, p.year, p.month, p.day);
  const day = 86400_000;

  // Monday-based day-of-week in local time.
  const dow = (new Date(localToUtc(zone, p.year, p.month, p.day)).getUTCDay() + 6) % 7;

  switch (keyword.toLowerCase().replace(/[\s-]+/g, '_')) {
    case 'today':
      return { from: startOfToday, to: new Date(startOfToday.getTime() + day), label: 'today' };
    case 'yesterday':
      return { from: new Date(startOfToday.getTime() - day), to: startOfToday, label: 'yesterday' };
    case 'this_week':
    case 'week_start': {
      const ws = new Date(startOfToday.getTime() - dow * day);
      return { from: ws, to: new Date(ws.getTime() + 7 * day), label: 'this week (Mon-start)' };
    }
    case 'last_week': {
      const ws = new Date(startOfToday.getTime() - (dow + 7) * day);
      return { from: ws, to: new Date(ws.getTime() + 7 * day), label: 'last week (Mon-start)' };
    }
    case 'this_month':
    case 'month_start': {
      const ms = localToUtc(zone, p.year, p.month, 1);
      const nextMonth = p.month === 12
        ? localToUtc(zone, p.year + 1, 1, 1)
        : localToUtc(zone, p.year, p.month + 1, 1);
      return { from: ms, to: nextMonth, label: 'this month' };
    }
    case 'last_month': {
      const start = p.month === 1
        ? localToUtc(zone, p.year - 1, 12, 1)
        : localToUtc(zone, p.year, p.month - 1, 1);
      const end = localToUtc(zone, p.year, p.month, 1);
      return { from: start, to: end, label: 'last month' };
    }
    case 'last_7_days':
    case 'last_7d':
      return { from: new Date(startOfToday.getTime() - 7 * day), to: startOfToday, label: 'last 7 complete days' };
    case 'last_30_days':
    case 'last_30d':
      return { from: new Date(startOfToday.getTime() - 30 * day), to: startOfToday, label: 'last 30 complete days' };
    case 'last_90_days':
    case 'last_90d':
      return { from: new Date(startOfToday.getTime() - 90 * day), to: startOfToday, label: 'last 90 complete days' };
    default:
      return null;
  }
}

const MAX_RANGE_DAYS = 400;

/**
 * Resolves a from/to pair.
 *
 * DOCUMENTED DEFAULT: when neither bound is given, the range is the last 30
 * complete days plus today. Chosen because it is the window that answers most
 * "how are we doing" questions without a scan of the whole table, and because
 * a default that silently excluded today would be surprising. The resolved
 * description is returned to the caller so the assumption is always stated.
 */
export function resolveRange(
  opts: { from?: string; to?: string; bucket?: string; timezone: string; now?: Date }
): ResolvedRange {
  const zone = opts.timezone;
  const now = opts.now ?? new Date();

  const bucket = (opts.bucket ?? 'day') as Bucket;
  if (!VALID_BUCKETS.includes(bucket)) {
    throw new McpToolError('invalid_argument', `Unknown bucket "${opts.bucket}".`, {
      hint: `Valid buckets: ${VALID_BUCKETS.join(', ')}.`,
      didYouMean: VALID_BUCKETS,
    });
  }

  let from: Date;
  let to: Date;
  let description: string;

  const parseBound = (v: string, isEnd: boolean): Date => {
    const m = ISO_DATE.exec(v.trim());
    if (m) {
      const [, y, mo, d] = m;
      const base = localToUtc(zone, Number(y), Number(mo), Number(d));
      // `to` is inclusive-of-the-named-day for humans, so an ISO end date
      // advances to the start of the following day internally.
      return isEnd ? new Date(base.getTime() + 86400_000) : base;
    }
    const kw = resolveKeyword(v, zone, now);
    if (kw) return isEnd ? kw.to : kw.from;

    throw new McpToolError('invalid_argument', `Could not interpret date "${v}".`, {
      hint:
        'Use YYYY-MM-DD, or one of: today, yesterday, this_week, last_week, this_month, ' +
        'last_month, last_7_days, last_30_days, last_90_days.',
      didYouMean: ['today', 'yesterday', 'last_7_days', 'last_30_days', 'this_month', 'last_month'],
    });
  };

  if (!opts.from && !opts.to) {
    const p = localParts(zone, now);
    const startOfToday = localToUtc(zone, p.year, p.month, p.day);
    from = new Date(startOfToday.getTime() - 30 * 86400_000);
    to = new Date(startOfToday.getTime() + 86400_000);
    description = 'last 30 days including today (default. No range was specified)';
  } else if (opts.from && !opts.to) {
    const kw = resolveKeyword(opts.from, zone, now);
    if (kw) {
      from = kw.from;
      to = kw.to;
      description = kw.label;
    } else {
      from = parseBound(opts.from, false);
      const p = localParts(zone, now);
      to = new Date(localToUtc(zone, p.year, p.month, p.day).getTime() + 86400_000);
      description = `${opts.from} to today`;
    }
  } else if (!opts.from && opts.to) {
    to = parseBound(opts.to, true);
    from = new Date(to.getTime() - 30 * 86400_000);
    description = `30 days ending ${opts.to}`;
  } else {
    // Both given. A keyword on either side resolves to its own span; using
    // from.start and to.end composes them correctly ("last_week" to "today").
    const fromKw = resolveKeyword(opts.from!, zone, now);
    const toKw = resolveKeyword(opts.to!, zone, now);
    from = fromKw ? fromKw.from : parseBound(opts.from!, false);
    to = toKw ? toKw.to : parseBound(opts.to!, true);
    description = `${opts.from} to ${opts.to}`;
  }

  if (to.getTime() <= from.getTime()) {
    throw new McpToolError('invalid_argument', 'The end of the range is not after the start.', {
      hint: `Resolved ${fmtLocal(zone, from)} to ${fmtLocal(zone, to)} in ${zone}. Check the order of from/to.`,
    });
  }

  const spanDays = (to.getTime() - from.getTime()) / 86400_000;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new McpToolError('invalid_argument', `Range spans ${Math.round(spanDays)} days; the maximum is ${MAX_RANGE_DAYS}.`, {
      hint: 'Narrow the range, or use a month bucket over a shorter window.',
    });
  }
  if (bucket === 'hour' && spanDays > 14) {
    throw new McpToolError('invalid_argument', 'Hourly buckets are limited to 14 days.', {
      hint: 'Use bucket="day" for ranges longer than two weeks.',
    });
  }

  return {
    fromUtc: from,
    toUtc: to,
    fromLocal: fmtLocal(zone, from),
    toLocal: fmtLocal(zone, to),
    bucket,
    timezone: zone,
    description,
    includesPartialBucket: to.getTime() > now.getTime(),
  };
}

/**
 * Marks the final bucket as partial when the range runs past "now".
 *
 * Without this, a time series ending today always shows a cliff on the last
 * point, and a model reading it will report a crash that is really just the
 * day not being over yet. Flagging is better than dropping the bucket:
 * "today so far" is genuinely useful, it just must not be compared like-for-
 * like against complete days.
 */
export function markPartialBuckets<T extends { bucket_start: string }>(
  rows: T[],
  range: ResolvedRange,
  now = new Date()
): (T & { is_partial?: boolean })[] {
  if (!range.includesPartialBucket || rows.length === 0) return rows;

  const boundary = bucketStartOf(range.bucket, range.timezone, now);
  return rows.map((r) => {
    const start = String(r.bucket_start).slice(0, 19).replace(' ', 'T');
    return start >= boundary ? { ...r, is_partial: true } : r;
  });
}

/** Local wall-clock start of the bucket containing `at`, as an ISO-ish string. */
function bucketStartOf(bucket: Bucket, zone: string, at: Date): string {
  const p = localParts(zone, at);
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (bucket) {
    case 'hour':
      return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:00:00`;
    case 'day':
      return `${p.year}-${pad(p.month)}-${pad(p.day)}T00:00:00`;
    case 'week': {
      const dow = (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7;
      const ws = new Date(Date.UTC(p.year, p.month - 1, p.day) - dow * 86400_000);
      return `${ws.getUTCFullYear()}-${pad(ws.getUTCMonth() + 1)}-${pad(ws.getUTCDate())}T00:00:00`;
    }
    case 'month':
      return `${p.year}-${pad(p.month)}-01T00:00:00`;
  }
}
