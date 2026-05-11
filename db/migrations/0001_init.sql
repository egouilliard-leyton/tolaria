-- Tolaria web SaaS — initial schema.
-- See docs/ARCHITECTURE-WEB-SAAS.md §4 and docs/adr/0115-multi-tenant-postgres-rls.md.

BEGIN;

-- ── Extensions ─────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- search prefix mode
CREATE EXTENSION IF NOT EXISTS vector;       -- pgvector for embeddings

-- ── Roles ──────────────────────────────────────────────────────────────────
-- Run these once per cluster as a superuser if not already present.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tolaria_app') THEN
    CREATE ROLE tolaria_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tolaria_migrator') THEN
    CREATE ROLE tolaria_migrator NOLOGIN;
  END IF;
END $$;

-- ── Helper: tenant context accessors ───────────────────────────────────────
CREATE OR REPLACE FUNCTION app_subscription_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.subscription_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- ── Subscriptions ──────────────────────────────────────────────────────────
CREATE TABLE subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  plan                  text NOT NULL DEFAULT 'free',
  ai_credits_remaining  bigint NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_self ON subscriptions
  USING (id = app_subscription_id());

-- ── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  email            citext NOT NULL,
  password_hash    text,                                    -- nullable; null when SSO-only
  role             text NOT NULL CHECK (role IN ('owner','admin','member')),
  display_name     text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, email)
);
-- citext lives in the citext extension; load lazily to keep this migration self-contained.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS citext;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_tenant ON users
  USING (subscription_id = app_subscription_id());

-- ── SSO providers ──────────────────────────────────────────────────────────
CREATE TABLE sso_providers (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id      uuid REFERENCES subscriptions(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  protocol             text NOT NULL DEFAULT 'oidc' CHECK (protocol IN ('oidc')),
  issuer_url           text NOT NULL,
  client_id            text NOT NULL,
  client_secret_enc    bytea NOT NULL,
  scopes               text[] NOT NULL DEFAULT ARRAY['openid','profile','email'],
  default_role         text NOT NULL DEFAULT 'member',
  jit_provisioning     boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);
-- Exactly one platform-default row (subscription_id IS NULL).
CREATE UNIQUE INDEX sso_providers_one_platform_default
  ON sso_providers ((1)) WHERE subscription_id IS NULL;
ALTER TABLE sso_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY sso_providers_tenant_or_global ON sso_providers
  USING (
    subscription_id IS NULL
    OR subscription_id = app_subscription_id()
  );

-- ── Vaults ────────────────────────────────────────────────────────────────
CREATE TABLE vaults (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  name             text NOT NULL,
  slug             text NOT NULL,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (subscription_id, slug)
);
ALTER TABLE vaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE vaults FORCE ROW LEVEL SECURITY;
CREATE POLICY vaults_tenant ON vaults
  USING (subscription_id = app_subscription_id());

CREATE TABLE vault_members (
  vault_id  uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      text NOT NULL CHECK (role IN ('viewer','editor','admin')),
  PRIMARY KEY (vault_id, user_id)
);
ALTER TABLE vault_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_members FORCE ROW LEVEL SECURITY;
CREATE POLICY vault_members_tenant ON vault_members
  USING (
    EXISTS (SELECT 1 FROM vaults v
            WHERE v.id = vault_members.vault_id
              AND v.subscription_id = app_subscription_id())
  );

-- ── Folders & notes ───────────────────────────────────────────────────────
CREATE TABLE folders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id    uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  parent_id   uuid REFERENCES folders(id) ON DELETE CASCADE,
  name        text NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vault_id, parent_id, name)
);
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE folders FORCE ROW LEVEL SECURITY;
CREATE POLICY folders_tenant ON folders
  USING (
    EXISTS (SELECT 1 FROM vaults v
            WHERE v.id = folders.vault_id
              AND v.subscription_id = app_subscription_id())
  );

CREATE TABLE notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id      uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  folder_id     uuid REFERENCES folders(id) ON DELETE SET NULL,
  slug          text NOT NULL,
  title         text NOT NULL,
  body_md       text NOT NULL DEFAULT '',
  frontmatter   jsonb NOT NULL DEFAULT '{}'::jsonb,
  word_count    integer NOT NULL DEFAULT 0,
  version       integer NOT NULL DEFAULT 1,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  modified_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (vault_id, slug)
);
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;
CREATE POLICY notes_tenant ON notes
  USING (
    EXISTS (SELECT 1 FROM vaults v
            WHERE v.id = notes.vault_id
              AND v.subscription_id = app_subscription_id())
  );

CREATE INDEX notes_vault_modified_idx ON notes (vault_id, modified_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX notes_vault_folder_idx ON notes (vault_id, folder_id)
  WHERE deleted_at IS NULL;

-- ── Link graph (denormalized; rebuilt by indexer) ──────────────────────────
CREATE TABLE note_links (
  src_note_id  uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  dst_note_id  uuid REFERENCES notes(id) ON DELETE SET NULL,
  dst_text     text NOT NULL,                                -- raw [[wikilink]] target
  kind         text NOT NULL DEFAULT 'wikilink' CHECK (kind IN ('wikilink','embed')),
  PRIMARY KEY (src_note_id, dst_text, kind)
);
ALTER TABLE note_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_links FORCE ROW LEVEL SECURITY;
CREATE POLICY note_links_tenant ON note_links
  USING (
    EXISTS (SELECT 1 FROM notes n
            JOIN vaults v ON v.id = n.vault_id
            WHERE n.id = note_links.src_note_id
              AND v.subscription_id = app_subscription_id())
  );

-- ── Search index ───────────────────────────────────────────────────────────
CREATE TABLE note_search (
  note_id    uuid PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  vault_id   uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  ts_doc     tsvector NOT NULL,
  embedding  vector(1536)
);
CREATE INDEX note_search_ts_idx ON note_search USING gin (ts_doc);
CREATE INDEX note_search_vault_idx ON note_search (vault_id);
ALTER TABLE note_search ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_search FORCE ROW LEVEL SECURITY;
CREATE POLICY note_search_tenant ON note_search
  USING (
    EXISTS (SELECT 1 FROM vaults v
            WHERE v.id = note_search.vault_id
              AND v.subscription_id = app_subscription_id())
  );

-- ── Attachments ────────────────────────────────────────────────────────────
CREATE TABLE attachments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id     uuid NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  note_id      uuid REFERENCES notes(id) ON DELETE SET NULL,
  key_r2       text NOT NULL,
  mime         text NOT NULL,
  size_bytes   bigint NOT NULL,
  sha256       text NOT NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  verified_at  timestamptz
);
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY attachments_tenant ON attachments
  USING (
    EXISTS (SELECT 1 FROM vaults v
            WHERE v.id = attachments.vault_id
              AND v.subscription_id = app_subscription_id())
  );

-- ── AI model registry (subscription-scoped or global fallback) ────────────
CREATE TABLE ai_models (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id   uuid REFERENCES subscriptions(id) ON DELETE CASCADE,
  provider          text NOT NULL,           -- 'openai' | 'anthropic' | …
  name              text NOT NULL,           -- LiteLLM route name
  display_name      text NOT NULL,
  capabilities      jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled           boolean NOT NULL DEFAULT true,
  default_for_kind  text                     -- 'chat' | 'agent' | 'embedding' | NULL
);
CREATE UNIQUE INDEX ai_models_global_unique ON ai_models (name)
  WHERE subscription_id IS NULL;
CREATE UNIQUE INDEX ai_models_tenant_unique ON ai_models (subscription_id, name)
  WHERE subscription_id IS NOT NULL;
ALTER TABLE ai_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_models FORCE ROW LEVEL SECURITY;
CREATE POLICY ai_models_tenant_or_global ON ai_models
  USING (
    subscription_id IS NULL
    OR subscription_id = app_subscription_id()
  );

-- ── Audit log ──────────────────────────────────────────────────────────────
CREATE TABLE audit_log (
  id               bigserial PRIMARY KEY,
  subscription_id  uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  actor_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action           text NOT NULL,
  target           text,
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_tenant ON audit_log
  USING (subscription_id = app_subscription_id());
CREATE INDEX audit_log_sub_created_idx ON audit_log (subscription_id, created_at DESC);

-- ── Refresh tokens (server-side opaque tokens; cookie carries the id) ─────
CREATE TABLE refresh_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  hashed_token    text NOT NULL,
  user_agent      text,
  ip              inet,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz
);
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY refresh_tokens_tenant ON refresh_tokens
  USING (subscription_id = app_subscription_id());

-- ── Grants ────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO tolaria_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tolaria_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tolaria_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tolaria_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO tolaria_app;

-- ── Seed: platform-default Authentik OIDC provider placeholder ────────────
-- The real values are inserted by an out-of-band setup script that reads
-- env vars and encrypts the client secret. Here we just leave the row
-- shape documented.

COMMIT;
