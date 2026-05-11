#!/bin/sh
set -e
echo "→ docker compose up -d"
docker compose up -d postgres minio litellm authentik authentik-redis
echo "→ waiting for postgres healthy"
until docker compose exec postgres pg_isready -U tolaria >/dev/null 2>&1; do sleep 1; done
echo "→ creating tolaria roles if needed"
docker compose exec -T postgres psql -U tolaria -d tolaria -c "
  DO \$\$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tolaria_app') THEN
      CREATE ROLE tolaria_app LOGIN PASSWORD 'devpw';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tolaria_migrator') THEN
      CREATE ROLE tolaria_migrator LOGIN PASSWORD 'devpw';
    END IF;
  END \$\$;"
echo "→ pnpm db:migrate"
pnpm db:migrate
echo "→ pnpm db:seed-platform (if Authentik env set)"
if [ -n "$AUTHENTIK_ISSUER_URL" ]; then pnpm db:seed-platform; fi
echo "✓ dev stack ready"
