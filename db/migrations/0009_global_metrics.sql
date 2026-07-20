-- ===========================================================================
-- 0009  Global metric definitions (org_id IS NULL = default for every org)
--
-- Per-org overrides are inserted by the seed script, because they reference
-- org UUIDs generated at seed time.
--
-- TEMPLATE CONTRACT
-- -----------------
-- Every template must produce exactly these four output columns:
--   bucket_start  timestamp   -- local wall-clock, already in the org's zone
--   dim_value     text        -- NULL when no dimension was requested
--   metric_value  numeric
--   currency      text        -- NULL for non-monetary metrics
--
-- Placeholders, all substituted in src/metrics/build.ts:
--   {{BUCKET}}       -> bound param: 'hour' | 'day' | 'week' | 'month'
--   {{TZ}}           -> bound param: the org's reporting_timezone
--   {{FROM}} {{TO}}  -> bound params: UTC instants of the local window edges
--   {{EVENT_NAMES}}  -> bound param: text[] of THIS org's raw event names,
--                       resolved from the canonical concepts in
--                       requires_canonical
--   {{DIM}}          -> a SQL expression looked up from a hardcoded table by
--                       exact match against allowed_dimensions. The model's
--                       string is used as a lookup key, never as SQL text.
--   {{FILTERS}}      -> parameterised AND-clauses built from validated filters
--
-- No org_id predicate appears anywhere in these templates. It is not needed
-- and its absence is deliberate: RLS supplies it, so a template can never be
-- the thing that gets tenant scoping wrong.
-- ===========================================================================

INSERT INTO metric_definitions
  (org_id, metric_key, display_name, description, unit, sql_template,
   allowed_dimensions, requires_canonical, notes)
VALUES

-- --------------------------------------------------------------- sessions --
(NULL, 'sessions_started', 'Sessions Started',
 'Count of session-start events. Resolves through each org''s own session-open event name (app_open, website_open, kiosk_open, ...).',
 'count',
 $tpl$
   SELECT date_trunc({{BUCKET}}, e.event_time AT TIME ZONE {{TZ}}) AS bucket_start,
          {{DIM}} AS dim_value,
          count(*)::numeric AS metric_value,
          NULL::text AS currency
   FROM events e
   WHERE e.event_name = ANY({{EVENT_NAMES}})
     AND e.event_time >= {{FROM}} AND e.event_time < {{TO}}
     {{FILTERS}}
   GROUP BY 1, 2
 $tpl$,
 ARRAY['platform', 'event_name', 'city', 'acquisition_source'],
 ARRAY['session_start'],
 'One row per session-start event, not per distinct session_id. An app that fires session_start on every foreground resume will read higher than its distinct-session count; use unique_sessions for the deduplicated figure.'),

(NULL, 'unique_sessions', 'Unique Sessions',
 'Distinct session_id values seen on session-start events. Deduplicated, so resume-heavy mobile apps do not inflate it.',
 'count',
 $tpl$
   SELECT date_trunc({{BUCKET}}, e.event_time AT TIME ZONE {{TZ}}) AS bucket_start,
          {{DIM}} AS dim_value,
          count(DISTINCT e.session_id)::numeric AS metric_value,
          NULL::text AS currency
   FROM events e
   WHERE e.event_name = ANY({{EVENT_NAMES}})
     AND e.event_time >= {{FROM}} AND e.event_time < {{TO}}
     AND e.session_id IS NOT NULL
     {{FILTERS}}
   GROUP BY 1, 2
 $tpl$,
 ARRAY['platform', 'city', 'acquisition_source'],
 ARRAY['session_start'],
 'Events with a NULL session_id are excluded, so this can be lower than sessions_started for reasons other than deduplication.'),

-- -------------------------------------------------------------- discovery --
(NULL, 'product_views', 'Product Views',
 'Count of product-detail-view events.',
 'count',
 $tpl$
   SELECT date_trunc({{BUCKET}}, e.event_time AT TIME ZONE {{TZ}}) AS bucket_start,
          {{DIM}} AS dim_value,
          count(*)::numeric AS metric_value,
          NULL::text AS currency
   FROM events e
   WHERE e.event_name = ANY({{EVENT_NAMES}})
     AND e.event_time >= {{FROM}} AND e.event_time < {{TO}}
     {{FILTERS}}
   GROUP BY 1, 2
 $tpl$,
 ARRAY['platform', 'event_name', 'city'],
 ARRAY['product_view'],
 NULL),

(NULL, 'searches', 'Searches Performed',
 'Count of search events.',
 'count',
 $tpl$
   SELECT date_trunc({{BUCKET}}, e.event_time AT TIME ZONE {{TZ}}) AS bucket_start,
          {{DIM}} AS dim_value,
          count(*)::numeric AS metric_value,
          NULL::text AS currency
   FROM events e
   WHERE e.event_name = ANY({{EVENT_NAMES}})
     AND e.event_time >= {{FROM}} AND e.event_time < {{TO}}
     {{FILTERS}}
   GROUP BY 1, 2
 $tpl$,
 ARRAY['platform', 'event_name', 'city'],
 ARRAY['search'],
 NULL),

(NULL, 'add_to_cart', 'Add to Cart',
 'Count of add-to-cart events.',
 'count',
 $tpl$
   SELECT date_trunc({{BUCKET}}, e.event_time AT TIME ZONE {{TZ}}) AS bucket_start,
          {{DIM}} AS dim_value,
          count(*)::numeric AS metric_value,
          NULL::text AS currency
   FROM events e
   WHERE e.event_name = ANY({{EVENT_NAMES}})
     AND e.event_time >= {{FROM}} AND e.event_time < {{TO}}
     {{FILTERS}}
   GROUP BY 1, 2
 $tpl$,
 ARRAY['platform', 'event_name', 'city'],
 ARRAY['add_to_cart'],
 NULL),

-- ----------------------------------------------------------------- orders --
-- GLOBAL DEFAULT for "an order": anything that reached a committed state.
-- Cancelled, returned and RTO-returned orders are excluded, because the
-- overwhelmingly common intent behind "how many orders did I do" is
-- "how many stuck". Orgs that disagree override this row. See the VoltEdge
-- and BazaarHub overrides inserted by the seed script.
(NULL, 'orders_count', 'Orders',
 'Number of orders placed in the window. GLOBAL DEFAULT: counts orders whose status is one of placed, paid, shipped, delivered. Excludes cancelled, returned and rto_returned.',
 'count',
 $tpl$
   SELECT date_trunc({{BUCKET}}, o.placed_at AT TIME ZONE {{TZ}}) AS bucket_start,
          {{DIM}} AS dim_value,
          count(*)::numeric AS metric_value,
          NULL::text AS currency
   FROM orders o
   WHERE o.status IN ('placed', 'paid', 'shipped', 'delivered')
     AND o.placed_at >= {{FROM}} AND o.placed_at < {{TO}}
     {{FILTERS}}
   GROUP BY 1, 2
 $tpl$,
 ARRAY['channel', 'status', 'coupon_code', 'city', 'acquisition_source', 'currency'],
 ARRAY[]::text[],
 'ASSUMPTION: "order" = reached a committed state (placed/paid/shipped/delivered). Cancelled and returned orders are NOT counted. Bucketed by placed_at, so an order placed Monday and delivered Friday counts on Monday.'),

-- Revenue is ALWAYS grouped by currency. Summing across currencies without a
-- conversion rate produces a number that is not money in any currency, and
-- this server does not have an FX feed. Callers get a per-currency breakdown
-- and an explicit note saying so.
(NULL, 'revenue', 'Revenue',
 'Sum of order totals, in minor units (paise/cents), ALWAYS broken down by currency. Never summed across currencies.',
 'currency_minor',
 $tpl$
   SELECT date_trunc({{BUCKET}}, o.placed_at AT TIME ZONE {{TZ}}) AS bucket_start,
          {{DIM}} AS dim_value,
          sum(o.total_amount_minor)::numeric AS metric_value,
          o.currency::text AS currency
   FROM orders o
   WHERE o.status IN ('placed', 'paid', 'shipped', 'delivered')
     AND o.placed_at >= {{FROM}} AND o.placed_at < {{TO}}
     {{FILTERS}}
   GROUP BY 1, 2, o.currency
 $tpl$,
 ARRAY['channel', 'status', 'coupon_code', 'city', 'acquisition_source'],
 ARRAY[]::text[],
 'Values are integer MINOR units: 149900 with currency INR means Rs 1,499.00. Multi-currency orgs receive one row per currency per bucket; these must not be added together.'),

(NULL, 'aov', 'Average Order Value',
 'Revenue divided by order count, in minor units, per currency.',
 'currency_minor',
 $tpl$
   SELECT date_trunc({{BUCKET}}, o.placed_at AT TIME ZONE {{TZ}}) AS bucket_start,
          {{DIM}} AS dim_value,
          -- NULLIF guards the empty-denominator case: a bucket with no orders
          -- yields NULL (unknown), not a division error and not a misleading 0.
          (sum(o.total_amount_minor)::numeric / NULLIF(count(*), 0)) AS metric_value,
          o.currency::text AS currency
   FROM orders o
   WHERE o.status IN ('placed', 'paid', 'shipped', 'delivered')
     AND o.placed_at >= {{FROM}} AND o.placed_at < {{TO}}
     {{FILTERS}}
   GROUP BY 1, 2, o.currency
 $tpl$,
 ARRAY['channel', 'coupon_code', 'city', 'acquisition_source'],
 ARRAY[]::text[],
 'NULL in a bucket means "no orders in that bucket", which is different from an AOV of zero.'),

(NULL, 'cancelled_orders', 'Cancelled Orders',
 'Orders that were cancelled, returned, or came back as RTO. The complement of the default orders_count.',
 'count',
 $tpl$
   SELECT date_trunc({{BUCKET}}, o.placed_at AT TIME ZONE {{TZ}}) AS bucket_start,
          {{DIM}} AS dim_value,
          count(*)::numeric AS metric_value,
          NULL::text AS currency
   FROM orders o
   WHERE o.status IN ('cancelled', 'returned', 'rto_returned')
     AND o.placed_at >= {{FROM}} AND o.placed_at < {{TO}}
     {{FILTERS}}
   GROUP BY 1, 2
 $tpl$,
 ARRAY['channel', 'status', 'city', 'currency'],
 ARRAY[]::text[],
 'Bucketed by placed_at, not by cancellation date, so it lines up with orders_count for a like-for-like ratio.'),

-- ------------------------------------------------------------------ users --
(NULL, 'active_users', 'Active Users',
 'Distinct identified users with at least one event in the bucket. Anonymous traffic is excluded.',
 'count',
 $tpl$
   SELECT date_trunc({{BUCKET}}, e.event_time AT TIME ZONE {{TZ}}) AS bucket_start,
          {{DIM}} AS dim_value,
          count(DISTINCT e.user_id)::numeric AS metric_value,
          NULL::text AS currency
   FROM events e
   WHERE e.event_time >= {{FROM}} AND e.event_time < {{TO}}
     AND e.user_id IS NOT NULL
     {{FILTERS}}
   GROUP BY 1, 2
 $tpl$,
 ARRAY['platform', 'event_name', 'city', 'acquisition_source'],
 ARRAY[]::text[],
 'Counts only logged-in identities. Anonymous visitors are not included and are not stitched in here. See the funnel tool for identity-stitched analysis.'),

(NULL, 'new_users', 'New Users',
 'Users whose first_seen_at falls inside the bucket.',
 'count',
 $tpl$
   SELECT date_trunc({{BUCKET}}, u.first_seen_at AT TIME ZONE {{TZ}}) AS bucket_start,
          {{DIM}} AS dim_value,
          count(*)::numeric AS metric_value,
          NULL::text AS currency
   FROM user_profiles u
   WHERE u.first_seen_at >= {{FROM}} AND u.first_seen_at < {{TO}}
     {{FILTERS}}
   GROUP BY 1, 2
 $tpl$,
 ARRAY['city', 'acquisition_source'],
 ARRAY[]::text[],
 'first_seen_at is the first event we ever received for that user, which may predate their account creation.'),

-- ------------------------------------------------------------- conversion --
(NULL, 'conversion_rate', 'Session-to-Order Conversion Rate',
 'Orders divided by unique sessions, as a ratio between 0 and 1. Both legs are computed over the same window and the same buckets.',
 'ratio',
 $tpl$
   WITH s AS (
     SELECT date_trunc({{BUCKET}}, e.event_time AT TIME ZONE {{TZ}}) AS b,
            count(DISTINCT e.session_id)::numeric AS sessions
     FROM events e
     WHERE e.event_name = ANY({{EVENT_NAMES}})
       AND e.event_time >= {{FROM}} AND e.event_time < {{TO}}
       AND e.session_id IS NOT NULL
     GROUP BY 1
   ),
   o AS (
     SELECT date_trunc({{BUCKET}}, ord.placed_at AT TIME ZONE {{TZ}}) AS b,
            count(*)::numeric AS orders
     FROM orders ord
     WHERE ord.status IN ('placed', 'paid', 'shipped', 'delivered')
       AND ord.placed_at >= {{FROM}} AND ord.placed_at < {{TO}}
     GROUP BY 1
   )
   SELECT COALESCE(s.b, o.b) AS bucket_start,
          NULL::text AS dim_value,
          -- NULLIF: zero sessions gives NULL ("cannot be computed"), not a
          -- divide-by-zero error and not a fake 0% conversion.
          (COALESCE(o.orders, 0) / NULLIF(s.sessions, 0)) AS metric_value,
          NULL::text AS currency
   FROM s FULL OUTER JOIN o ON s.b = o.b
 $tpl$,
 ARRAY[]::text[],
 ARRAY['session_start'],
 'ASSUMPTION: denominator is unique sessions, not users and not visitors. NULL means there were no sessions to divide by. Not dimensionable: a per-dimension conversion rate needs the order attributed to the session that produced it, which requires session stitching this projection does not yet do.');
