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

### Local development (one-shot bootstrap)

The `scripts/dev-bootstrap.sh` script in the repo root brings up the full
local stack in one go:

```bash
./scripts/dev-bootstrap.sh
```

It does:

1. `docker compose up -d` for `postgres`, `minio`, `litellm`, `authentik`,
   and `authentik-redis`.
2. Waits for the Postgres healthcheck to report ready.
3. Creates the `tolaria_app` and `tolaria_migrator` roles if they don't
   exist (idempotent).
4. Runs `pnpm db:migrate` to apply every SQL migration under
   `db/migrations/`.
5. Runs `pnpm db:seed-platform` when `AUTHENTIK_ISSUER_URL` is set,
   inserting (or updating) the platform-default Authentik OIDC provider
   row in `sso_providers` so first-time login can succeed. The seeder
   itself is idempotent: re-running with the same env is a no-op.

After the script finishes, start the API and worker:

```bash
pnpm --filter @tolaria/api dev      # http://localhost:8787
pnpm --filter @tolaria/worker dev   # pg-boss consumer
pnpm dev:web                        # http://localhost:5201
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

## Web build

The browser-only frontend that talks to this API is produced from the same
React tree under `src/` via:

```bash
pnpm build:web              # ➜ dist-web/
pnpm dev:web                # ➜ http://localhost:5201
```

`VITE_TARGET=web` switches `vite.config.ts` to:

- alias every `@tauri-apps/api*` and `@tauri-apps/plugin-*` import to
  `src/lib/web-build/tauri-stub.ts` (any forgotten desktop-only call surface
  fails loud at runtime),
- inject `import.meta.env.VITE_TARGET = 'web'` and `WEB_SAAS_ENABLED = true`,
- emit the bundle to `dist-web/` so it does not collide with the desktop
  output in `dist/`.

`src/main.tsx` picks the right `VaultAdapter` at boot — `HttpVaultAdapter`
(this API) for the web build and `TauriVaultAdapter` for desktop — and
wraps the web tree in `<AuthProvider />` so silent refresh runs before any
component reads the auth state. The desktop tree is unchanged.

Set `VITE_API_BASE_URL` to point the SPA at a non-default API origin
(defaults to `'/'`, i.e. same-origin).
