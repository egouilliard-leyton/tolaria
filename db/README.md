# Database migrations

Plain SQL migrations applied in lexical order. The API does not auto-migrate
in production — run `pnpm --filter @tolaria/api db:migrate` (or pipe each
file into `psql`) using the migrator role.

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
