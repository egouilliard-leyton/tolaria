# @tolaria/api

Hono HTTP server for the Tolaria web SaaS. See
[`docs/ARCHITECTURE-WEB-SAAS.md`](../../docs/ARCHITECTURE-WEB-SAAS.md) for the
full topology.

## Run locally

```bash
cp ../../.env.example .env       # then fill in real values
pnpm install
pnpm --filter @tolaria/api dev
```

The server listens on `API_HOST:API_PORT` (default `127.0.0.1:8787`) and
exposes:

- `GET /healthz` — liveness, no auth
- `GET /readyz` — DB ping + dependency probes
- everything else — gated by `requireAuth` + `withTenantContext`

Per-request tenant isolation is enforced by Postgres RLS via
`SET LOCAL app.subscription_id = …` inside a transaction; see
`docs/adr/0115-multi-tenant-postgres-rls.md`.

## Layout

```
src/
  index.ts                   HTTP entry, signal handling
  env.ts                     Zod-validated process.env loader
  db.ts                      pg.Pool + withTenant transaction wrapper
  lib/{logger,errors}.ts
  middleware/{auth,tenant,error-handler}.ts
  routes/
    health.ts                /healthz, /readyz
    index.ts                 mounts feature modules below
    (auth, vaults, notes, search, rename, attachments, ai, admin/sso) — agent-owned
  services/                  authentik client, r2 client, litellm client (agent-owned)
```

Each feature stream owns one file under `routes/` and may grow a sibling
`services/` module for upstream clients. Cross-stream code lives in `lib/`.

## Tests

```bash
pnpm --filter @tolaria/api test
```

Tests run against a real Postgres (set `DATABASE_URL` to a disposable test DB).
RLS policies are exercised end-to-end so isolation regressions fail at CI.
