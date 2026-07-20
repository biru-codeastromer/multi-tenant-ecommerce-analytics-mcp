# Deployment runbook. Supabase + Railway

Free tier throughout. Roughly 30 minutes end to end.

Nothing here requires a secret to be committed. **Every secret is set through a dashboard
or CLI and lives only in the platform's environment store.**

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

## 3. Deploy the server to Railway

```bash
npm i -g @railway/cli
railway login
railway init
```

Set variables. **`DATABASE_URL_OWNER` is deliberately NOT set on the server.** The runtime
never needs owner privileges, and not having the credential present is stronger than having
it and not using it.

```bash
railway variables set \
  DATABASE_URL_TENANT="postgresql://mcp_tenant.<ref>:<pw>@...:6543/postgres" \
  DATABASE_URL_AUTH="postgresql://mcp_auth.<ref>:<pw>@...:6543/postgres" \
  API_KEY_PEPPER="<the same pepper used at seed time>" \
  NODE_ENV=production \
  PORT=8787 \
  STATEMENT_TIMEOUT_MS=8000 \
  MAX_ROWS_RETURNED=500 \
  RATE_LIMIT_PER_MINUTE=60

railway up
railway domain          # public HTTPS URL
```

> **The pepper must match the one used when seeding.** It is mixed into the key hash, so a
> different pepper invalidates every issued credential. That is also how you'd perform an
> emergency mass-revocation.

Verify:

```bash
curl https://<your-app>.up.railway.app/health

curl -s -X POST https://<your-app>.up.railway.app/mcp \
  -H "Authorization: Bearer zyk_nordvik-fashion_<secret>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

A correct response contains an `instructions` string carrying **that org's** taxonomy.

---

## 4. Keep the demo alive

Supabase free tier **pauses a project after 7 days of no activity**, which would take the
demo down mid-review. Two independent mitigations:

**a. Railway cron. Runs discovery hourly and touches the database.** Add to
`railway.json`:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": { "builder": "NIXPACKS" },
  "deploy": {
    "startCommand": "npm start",
    "healthcheckPath": "/health",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

Then a second Railway service, cron `0 * * * *`, running `npm run refresh`
(`db:project && db:discover`). This is the same job that keeps the registry current, so the
keepalive is a side effect of work that needed doing rather than a fake ping.

> That cron service **does** need `DATABASE_URL_OWNER`, since it writes. Keep it as a
> separate service so the public-facing server never holds owner credentials.

**b. An external uptime monitor** (UptimeRobot, Better Stack. Both free) hitting
`/health` every 5 minutes. `/health` runs `SELECT 1` on the auth pool, which is enough to
count as activity, and it returns no tenant data.

---

## 5. Connect from Claude

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zyaro-analytics": {
      "url": "https://<your-app>.up.railway.app/mcp",
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

| Service | Tier | Limit that bites first |
|---|---|---|
| Supabase | Free | 500 MB storage; pauses after 7 idle days |
| Railway | Free/Hobby | $5/mo credit; sleeps on the free plan |

The 17k-event seed is roughly 25 MB with indexes. Comfortably inside 500 MB. At real
production volume, `events` is what grows, and monthly partitioning plus a retention policy
(README → *What I'd build next*) is the answer.

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
