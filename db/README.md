# Database migrations

Plain SQL migrations applied in lexical order. The API does not auto-migrate
in production. The preferred way to apply migrations is the bundled Node
runner in `db/migrate.ts`, which records every applied file in a `_migrations`
table and skips files it has already run:

```bash
# Uses DATABASE_MIGRATOR_URL (preferred) or DATABASE_URL.
pnpm db:migrate
```

The runner is idempotent — re-running it after adding a new migration only
applies the new file, wrapped in a transaction. If you need to apply a single
file by hand (e.g. on a remote box without Node), you can still pipe it
through `psql` using the migrator role:

```bash
psql "$DATABASE_MIGRATOR_URL" -f db/migrations/0001_init.sql
```

Conventions:

- One file per migration, prefixed `NNNN_short_slug.sql`. No reverse
  migrations — roll forward.
- Every tenant-owned table must declare `subscription_id uuid not null` and
  enable RLS (see `docs/adr/0115-multi-tenant-postgres-rls.md`).
- Migrations run as the `tolaria_migrator` role; the application connects as
  the `tolaria_app` role for which RLS is enforced.

## Production role passwords

The local dev stack creates both roles with the placeholder password
`devpw` (see `scripts/dev-bootstrap.sh`). **Production deployments MUST
create the `tolaria_app` and `tolaria_migrator` LOGIN roles with
distinct, high-entropy passwords** and supply them to the API/worker
via `DATABASE_URL` and `DATABASE_MIGRATOR_URL` respectively. The two
roles MUST stay separate: `tolaria_app` connects under RLS, while
`tolaria_migrator` is the only role permitted to run DDL. Rotate the
passwords on the same cadence as any other production secret; pg-boss
and the Hono pool both honour the connection string on restart, so a
zero-downtime rotation is a connection-string change plus a rolling
restart of the api + worker pods. The Helm chart / ops playbook is the
right place to record the rotation cadence; this README only
documents the contract.
