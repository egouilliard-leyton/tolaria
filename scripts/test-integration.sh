#!/bin/sh
# Local integration test runner — boots the Postgres container from
# docker-compose, applies migrations, then runs the @tolaria/api and
# @tolaria/worker suites against the live DB. The 12 SQL-direct tests
# skip on a vanilla `pnpm test` because they need a real Postgres; this
# script is the one-liner the CI and contributors use to exercise them
# locally. Hooked from root `package.json` as `pnpm test:integration`.
set -e
echo "→ docker compose up -d postgres"
docker compose up -d postgres
until docker compose exec postgres pg_isready -U tolaria >/dev/null 2>&1; do sleep 1; done
echo "→ pnpm db:migrate"
pnpm db:migrate
echo "→ pnpm --filter @tolaria/api test"
DATABASE_URL=postgres://tolaria_app:devpw@localhost:5432/tolaria \
  pnpm --filter @tolaria/api test
echo "→ pnpm --filter @tolaria/worker test"
DATABASE_URL=postgres://tolaria_app:devpw@localhost:5432/tolaria \
  pnpm --filter @tolaria/worker test
