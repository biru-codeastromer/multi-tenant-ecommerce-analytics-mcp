# Deployment runbook. Supabase + Render, free tier, no credit card

Roughly 30 minutes end to end, and **nothing here costs money or asks for a card**.

- **Supabase** hosts the Postgres. Free plan, no card, 500 MB, up to 2 projects. A free
  project pauses after 7 days of inactivity but keeps all its data.
- **Render** hosts the MCP server. Free plan, no card, runs a normal Node app. A free web
  service sleeps after 15 minutes idle and takes ~30-60s to answer the first request after
  that; the keepalive in step 4 hides this and also stops Supabase pausing.

Why not Railway or Fly.io: both dropped their no-card free tiers, so they are avoided here.
Render + Supabase is the current genuinely-free path, and the brief explicitly allows a
free tier.

Nothing here requires a secret to be committed. **Every secret is set through a dashboard
and lives only in the platform's environment store.**

---

## 1. Create the Supabase project

1. <https://supabase.com/dashboard> → **New project**.
2. Pick a region close to your users (`ap-south-1` for India).
3. Save the database password to your password manager. You cannot view it again.
4. Wait for provisioning (~2 min).

### Get the two connection strings

**Project Settings → Database → Connection string.** You need both, and the difference
matters:

| Use | Mode | Port | Why |
|---|---|---|---|
| Migrations, seed, projection, discovery | **Session** (or Direct) | 5432 | DDL and `CREATE ROLE` need a real session |
| The MCP server's tenant + auth pools | **Transaction** | 6543 | Multiplexes; what the free tier is sized for |

> **The transaction pooler is exactly why `withOrgSession()` uses `SET LOCAL` rather than
> `SET`.** In transaction mode a backend is returned to the pool at `COMMIT` and handed to
> another client. A session-scoped GUC would survive that handoff and leak one tenant's
> context into another's next query. See README → *The pooler trap*.

---

## 2. Apply the schema

Locally, pointed at Supabase:

```bash
# Role passwords. No quotes, backslashes or whitespace (they land in a SQL literal)
export MCP_TENANT_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=')
export MCP_AUTH_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=')
export API_KEY_PEPPER=$(openssl rand -hex 32)

# SESSION pooler / direct connection. Port 5432
export DATABASE_URL_OWNER="postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres"

# TRANSACTION pooler. Port 6543. With the roles the migration creates
export DATABASE_URL_TENANT="postgresql://mcp_tenant.<ref>:${MCP_TENANT_PASSWORD}@aws-0-<region>.pooler.supabase.com:6543/postgres"
export DATABASE_URL_AUTH="postgresql://mcp_auth.<ref>:${MCP_AUTH_PASSWORD}@aws-0-<region>.pooler.supabase.com:6543/postgres"

npm run db:migrate     # creates roles, tables, FORCE RLS policies, indexes
npm run db:seed        # 5 orgs, ~17k events. PRINTS THE API KEYS ONCE
npm run db:project     # derives orders/order_items/products/user_profiles
npm run db:discover    # populates the property registry
```

**Capture the API keys from the seed output immediately.** Only a peppered SHA-256 hash is
stored; they are not recoverable.

Save them somewhere gitignored:

```bash
npm run db:seed 2>&1 | grep zyk_ > credentials.local.txt   # already in .gitignore
```

### Verify isolation actually applied

Do not skip this: it is the whole assignment.

```bash
npm run test:isolation     # 43 tests, run against Supabase
```

Or by hand in the SQL editor:

```sql
-- every tenant table must show BOTH true
SELECT relname, relrowsecurity AS enabled, relforcerowsecurity AS forced
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND relkind = 'r' ORDER BY 1;

-- both must be f / f
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'mcp%';

-- must return 0 rows: no tenant context set
SET ROLE mcp_tenant;
SELECT count(*) FROM events;
RESET ROLE;
```

---

## 3. Deploy the server to Render (free, no card)

The repo ships a `render.yaml` Blueprint, so this is mostly clicking.

1. Sign up at <https://render.com> with your GitHub account. No credit card is requested for
   the free plan.
2. **New +** -> **Blueprint** -> pick this repo. Render reads `render.yaml`, sees the free
   web service, and asks for the three secret values it marks `sync: false`:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL_TENANT` | `postgresql://mcp_tenant.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres` |
   | `DATABASE_URL_AUTH` | `postgresql://mcp_auth.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres` |
   | `API_KEY_PEPPER` | the **same** pepper used when you seeded |

   Both DB URLs use the Supabase **transaction pooler** (port 6543).
3. **Apply**. Render runs `npm ci && npm run build`, then `npm start`, and gives you a public
   `https://<name>.onrender.com` URL with managed TLS.

Notes:

- **`DATABASE_URL_OWNER` is deliberately NOT set on the server.** The runtime never needs
  owner privileges; not having the credential present is stronger than having it unused.
- **`PORT` is not set by you.** Render injects it and `src/config.ts` reads it.
- **The pepper must match the one used when seeding**, because it is mixed into the key hash.
  Setting a different pepper invalidates every issued credential, which is also how you would
  perform an emergency mass-revocation.

Prefer no dashboard? The same repo has a `Dockerfile`, so Render's "Web Service -> Docker"
path works too; the Blueprint is just faster.

Verify (the first call may take ~30-60s if the free service was asleep):

```bash
curl https://<your-app>.onrender.com/health

curl -s -X POST https://<your-app>.onrender.com/mcp \
  -H "Authorization: Bearer zyk_nordvik-fashion_<secret>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

A correct response contains an `instructions` string carrying **that org's** taxonomy.

---

## 4. Keep the demo alive (free)

Two idle timers threaten a demo: Supabase pauses a project after **7 days** of no activity,
and a Render free web service sleeps after **15 minutes**. One free cron handles both.

Use a free external pinger. **[cron-job.org](https://cron-job.org)** and **UptimeRobot**
both have no-card free plans. Point it at:

```
https://<your-app>.onrender.com/health
```

every 10 minutes. That single request does everything needed:

- it wakes the Render service and keeps it responsive, and
- `/health` runs `SELECT 1` on the database, which counts as Supabase activity and resets
  its 7-day pause timer.

`/health` returns no tenant data and needs no credential, so it is safe to hit from a public
monitor. A 10-minute interval stays comfortably inside Render's 750 free instance-hours per
month.

> **Refreshing the registry.** The projection and discovery jobs (`npm run refresh`) are
> maintenance, not part of serving requests, so they do not need to run in the cloud for the
> demo. If you want them on a schedule, run `npm run refresh` locally against the Supabase
> URL whenever you like, or add a second free Render **Cron Job** service running it. That
> service is the only place `DATABASE_URL_OWNER` belongs, kept separate so the public server
> never holds owner credentials.

---

## 5. Connect from Claude

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zyaro-analytics": {
      "url": "https://<your-app>.onrender.com/mcp",
      "headers": { "Authorization": "Bearer zyk_nordvik-fashion_<secret>" }
    }
  }
}
```

Questions worth trying:

- "What events do I track?". Org-specific names, no round-trip needed
- "How many orders did I do last week from search?". The brief's motivating question
- "Show me my funnel from session to purchase"
- "What are people searching for that returns no results?"
- "Compare my conversion rate to other stores". Should decline, with a reason
- To Aurelia: "how many searches yesterday?". Should say *not tracked*, not zero
- With the restricted key, ask it to "run raw SQL": `run_sql` is not offered and is refused
  if forced, while named-metric questions still work

---

## Rotating and revoking credentials

```sql
-- revoke one key; effective on the NEXT request, no restart, no cache to clear
UPDATE api_credentials SET revoked_at = now() WHERE key_prefix = 'zyk_nordvik';

-- issue a new one: generate with scripts, insert only the hash
-- (see generateApiKey() in src/auth/credentials.ts)
```

Emergency mass revocation: rotate `API_KEY_PEPPER` and redeploy. Every existing key stops
resolving instantly.

---

## Cost

| Service | Tier | Cost | Limit that bites first |
|---|---|---|---|
| Supabase | Free | $0, no card | 500 MB storage; pauses after 7 idle days |
| Render | Free | $0, no card | sleeps after 15 min idle; 750 instance-hours/month |
| cron-job.org / UptimeRobot | Free | $0, no card | interval floor, well below what is needed |

Total out of pocket: nothing. The 17k-event seed is roughly 25 MB with indexes, comfortably
inside 500 MB. At real production volume `events` is what grows, and monthly partitioning
plus a retention policy (README → *What I'd build next*) is the answer.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `password authentication failed for user "mcp_tenant"` | Roles created before the password env var was set, or a mismatch | Re-run `npm run db:migrate`; `ALTER ROLE` is idempotent |
| Queries return 0 rows for everything | Tenant context not applied | Confirm `set_tenant_context` exists (migration 0010) and the role holds EXECUTE |
| `permission denied for function set_config` | **Expected** for `mcp_tenant`. This is migration 0010 working | Nothing to fix; context goes through `set_tenant_context()` |
| `remaining connection slot reserved` | Using the direct connection instead of the transaction pooler | Point `DATABASE_URL_TENANT`/`_AUTH` at port 6543 |
| Migration fails on `${MCP_TENANT_PASSWORD}` | Password contains a quote/backslash/space | Regenerate with the `tr -d '/+='` recipe above |
| Project paused | 7 idle days | Resume in the dashboard, then set up the keepalive in step 4 |
