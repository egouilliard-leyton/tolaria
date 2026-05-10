# Tolaria — Web SaaS Architecture

Status: Draft, exploration branch `claude/tolaria-web-app-exploration-Wh5IP`.
This document is the working plan for porting Tolaria from a single-user Tauri
desktop app (filesystem source-of-truth, in-process Rust backend, on-disk Git)
to a multi-tenant web SaaS while keeping the existing desktop client working.

> Companion ADRs: [0115](adr/0115-multi-tenant-postgres-rls.md),
> [0116](adr/0116-attachments-on-cloudflare-r2.md),
> [0117](adr/0117-authentik-oidc-sso.md).

---

## 1. Goals & non-goals

### Goals

- A web build of the existing Tolaria UI (`pnpm build:web`) that runs in any
  modern browser without Tauri.
- Multi-tenant SaaS hosting: subscriptions own users, vaults, notes, and
  attachments. Per-row Postgres RLS guarantees isolation.
- SSO via OIDC (Authentik default; admin UI lets a subscription owner add
  their own provider). Local password auth stays for desktop dev.
- A single AI proxy (LiteLLM) so model routing, key custody, rate limits, and
  per-subscription model registries live server-side. The browser never
  touches model API keys.
- Attachments stored in Cloudflare R2 with presigned PUT/GET; the database
  records metadata only.
- Background jobs (search indexing, link graph maintenance, rename
  propagation, AI tool runs) run in a dedicated worker via `pg-boss`.
- Desktop app keeps working: it speaks the same HTTP API in "synced" mode and
  the existing Rust commands in "local" mode.

### Non-goals (this revision)

- We do not port `mcp-server`, `claude_cli`, `gemini_cli`, `opencode_cli`, or
  `pi_cli`. Those stay desktop-only — they shell out to local binaries the
  browser cannot reach.
- We do not port the Git surface (`git_commit`, `git_push`, conflict UI). The
  web build replaces "vault is a git repo" with "vault is a row in Postgres".
- We do not move BlockNote / TipTap to the server. Editing remains client-side.
- We do not implement E2E encryption in v1. Notes are stored in plaintext at
  rest; R2 objects are encrypted at rest by Cloudflare. v2 may layer
  client-side encryption per-vault.

---

## 2. Topology

```
                    ┌────────────────────────────────────────────┐
                    │              Browser (web build)           │
                    │   React + BlockNote + HttpVaultAdapter     │
                    └───────────────┬────────────────────────────┘
                                    │  HTTPS (JWT)
                                    ▼
                    ┌────────────────────────────────────────────┐
   OIDC (Authentik) │              apps/api  (Hono)              │ ◀── R2 presigned URLs
   ────────────────▶│  routes:                                   │
                    │   /auth   /me   /vaults   /notes   /search │
                    │   /rename /attachments  /ai/*  /admin/sso  │
                    └─────┬───────────────────────┬──────────────┘
                          │ pg pool (RLS-enforced)│ enqueues jobs
                          ▼                       ▼
                    ┌────────────────┐   ┌─────────────────────┐
                    │   Postgres     │   │   apps/worker       │
                    │  + pg_trgm     │   │   pg-boss runtime   │
                    │  + pgvector    │   │   indexer, rename   │
                    │  + RLS         │   │   propagation, AI   │
                    └────────┬───────┘   └──────────┬──────────┘
                             │                      │
                             │                      ▼
                             │             ┌─────────────────┐
                             │             │  LiteLLM proxy  │
                             │             │ (model routing) │
                             │             └────────┬────────┘
                             │                      │
                             ▼                      ▼
                     Cloudflare R2          OpenAI / Anthropic /
                     (attachments)            Gemini / Bedrock
```

Everything below the API is private; the browser talks only to `apps/api`.

---

## 3. Repository layout (target)

```
tolaria/
├── apps/
│   ├── api/                Hono server (Node 22, TS, ESM)
│   │   ├── src/
│   │   │   ├── index.ts            HTTP entry, route mounting
│   │   │   ├── env.ts              Zod-validated process.env loader
│   │   │   ├── db.ts               pg.Pool + per-request RLS session vars
│   │   │   ├── auth/               OIDC client, JWT mint/verify, /auth routes
│   │   │   ├── middleware/         requireAuth, withTenant, errorHandler
│   │   │   ├── routes/
│   │   │   │   ├── vaults.ts
│   │   │   │   ├── notes.ts
│   │   │   │   ├── search.ts
│   │   │   │   ├── rename.ts
│   │   │   │   ├── attachments.ts
│   │   │   │   ├── ai.ts           SSE proxy to LiteLLM
│   │   │   │   └── admin/sso.ts
│   │   │   ├── services/           authentik client, r2 client, litellm client
│   │   │   ├── jobs/               enqueue helpers (pg-boss producers)
│   │   │   └── lib/                validation schemas, errors
│   │   ├── test/
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── worker/             pg-boss consumer (Node 22, TS, ESM)
│       ├── src/
│       │   ├── index.ts            boots pg-boss + handlers
│       │   ├── handlers/           index-note, propagate-rename, ai-tool-run
│       │   └── env.ts
│       ├── package.json
│       └── tsconfig.json
│
├── db/
│   ├── migrations/
│   │   └── 0001_init.sql           tenant tables, RLS, extensions, seeds
│   └── README.md                   how to run migrations
│
├── src/                    existing React app (frontend)
│   ├── lib/
│   │   └── vault-adapter/          NEW: VaultAdapter interface + impls
│   │       ├── index.ts                  exports the active adapter
│   │       ├── types.ts                  VaultAdapter contract
│   │       ├── tauri-adapter.ts          calls invoke() (current behavior)
│   │       └── http-adapter.ts           calls apps/api over fetch + SSE
│   └── …
│
├── src-tauri/              existing Rust crate, unchanged
├── .env.example            documents all server env vars
├── pnpm-workspace.yaml     extended to include apps/*
└── docs/ARCHITECTURE-WEB-SAAS.md   ← this file
```

The desktop build still runs from `src/` + `src-tauri/` and emits to `dist/`.
The web build runs from `src/` + `apps/api`, is produced via `pnpm build:web`
(`VITE_TARGET=web`), and emits to `dist-web/`. The selector is the
`VaultAdapter` factory in `src/lib/vault-adapter/index.ts`, chosen at app
boot from `import.meta.env.VITE_TARGET`.

---

## 4. Data model (v1)

All tenant-owned tables carry `subscription_id uuid not null` and have an RLS
policy that allows access only when
`subscription_id = current_setting('app.subscription_id')::uuid`.

```
subscriptions (id, name, plan, ai_credits_remaining, created_at)
users         (id, subscription_id, email, role, created_at)
              role: 'owner' | 'admin' | 'member'

sso_providers (id, subscription_id, name, issuer_url, client_id,
               client_secret_enc, scopes_json, default_role,
               jit_provisioning, created_at)
              -- one Authentik fallback row with subscription_id = NULL is
              -- allowed via a partial unique index for the platform default.

vaults        (id, subscription_id, name, slug, created_by, created_at,
               settings_jsonb)
vault_members (vault_id, user_id, role)            role: viewer/editor/admin

folders       (id, vault_id, parent_id, name, position, updated_at)
notes         (id, vault_id, folder_id, slug, title, body_md, frontmatter_jsonb,
               word_count, modified_at, created_at, deleted_at, version int)
              -- soft delete on deleted_at. version monotonically increments
              -- on every save for optimistic concurrency.

note_links    (src_note_id, dst_note_id, dst_text, kind)
              -- denormalized link graph; rebuilt by the indexer worker.

note_search   (note_id primary key, vault_id, ts_doc tsvector, embedding vector(1536))
              -- separate row keeps the hot search columns off the notes table.

attachments   (id, vault_id, note_id nullable, key_r2, mime, size_bytes,
               sha256, created_by, created_at)

ai_models     (id, subscription_id nullable, provider, name, display_name,
               capabilities_jsonb, enabled, default_for_kind)
              -- subscription_id null = platform-global model (Authentik
              -- equivalent fallback for AI). Subscription owners can add
              -- their own.

audit_log     (id, subscription_id, actor_user_id, action, target, meta_jsonb,
               created_at)
```

### Why RLS over query-level scoping

Two reasons. First, defense in depth: a single missing `WHERE subscription_id = …`
in any of the dozens of upcoming queries would silently leak across tenants.
Postgres RLS makes that physically impossible — the planner appends the policy
unconditionally. Second, both `apps/api` and `apps/worker` share the same
database connection; RLS lets the worker run with `app.subscription_id` set
per-job without re-implementing the API's tenant guard. See ADR-0115.

### Connection pattern

```ts
// apps/api/src/db.ts
export async function withTenant<T>(
  subscriptionId: string,
  userId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL app.subscription_id = $1`, [subscriptionId])
    await client.query(`SET LOCAL app.user_id = $1`, [userId])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
```

`SET LOCAL` is scoped to the transaction, so a connection returned to the pool
cannot leak tenant context to the next caller.

---

## 5. API surface (v1)

All routes are JSON unless marked `(SSE)`. Auth is `Authorization: Bearer <jwt>`.

```
POST   /auth/login              local-password (dev only); returns JWT
GET    /auth/oidc/:providerId   redirect to provider, with PKCE
GET    /auth/oidc/:providerId/callback
POST   /auth/logout             revoke refresh token

GET    /me                      current user + subscription + role

GET    /vaults
POST   /vaults                  { name, slug }
GET    /vaults/:id
PATCH  /vaults/:id              { name, settings }
DELETE /vaults/:id              soft delete

GET    /vaults/:id/folders
POST   /vaults/:id/folders      { parent_id, name }
PATCH  /folders/:id             { name, parent_id, position }
DELETE /folders/:id

GET    /vaults/:id/notes        ?folder_id=&limit=&cursor=
POST   /vaults/:id/notes        { folder_id, title, body_md, frontmatter }
GET    /notes/:id               returns body_md + frontmatter + version
PUT    /notes/:id               { body_md, frontmatter, expected_version } 409 on conflict
DELETE /notes/:id               soft delete; hard-delete by retention worker

POST   /vaults/:id/rename       { from_path, to_path } updates wikilinks atomically;
                                returns affected note ids.

GET    /vaults/:id/search       ?q=&mode=full|prefix&limit=

POST   /vaults/:id/attachments  body: { mime, size, sha256 }
                                returns: { id, put_url, get_url, key }
GET    /attachments/:id         redirect to time-limited GET URL

POST   /ai/chat                 (SSE)  { vault_id, model, messages, tools }
POST   /ai/agent/run            (SSE)  { vault_id, model, tools, prompt }
GET    /ai/models               available models for current subscription

GET    /admin/sso/providers
POST   /admin/sso/providers     owner only
PATCH  /admin/sso/providers/:id
DELETE /admin/sso/providers/:id
GET    /admin/users             list members + invite UI
POST   /admin/users/invite      { email, role }

GET    /healthz                 liveness
GET    /readyz                  DB ping + R2 ping + LiteLLM ping
```

### Streaming

`POST /ai/chat` returns a `text/event-stream`. The API forwards events 1:1 from
LiteLLM (`data: {…}\n\n` frames) and injects a final `event: usage` frame with
the token counts so the frontend can decrement `ai_credits_remaining`. Each
chunk is also written to a `ai_runs` row for audit.

---

## 6. Frontend integration

### `VaultAdapter` interface

The desktop app today calls `invoke('save_note_content', …)` etc. directly
from React. We introduce a thin interface that both backends implement; the
React code only sees the interface.

```ts
// src/lib/vault-adapter/types.ts
export interface VaultAdapter {
  listVaults(): Promise<Vault[]>
  openVault(id: string): Promise<VaultHandle>

  listFolders(vaultId: string): Promise<Folder[]>
  listNotes(vaultId: string, opts?: { folderId?: string; cursor?: string }): Promise<Page<NoteSummary>>
  getNote(noteId: string): Promise<Note>
  saveNote(noteId: string, body: SaveNoteRequest): Promise<{ version: number }>
  createNote(vaultId: string, body: CreateNoteRequest): Promise<Note>
  deleteNote(noteId: string): Promise<void>

  rename(vaultId: string, fromPath: string, toPath: string): Promise<RenameResult>
  search(vaultId: string, q: string, mode: 'full' | 'prefix'): Promise<SearchResponse>

  uploadAttachment(file: Blob, meta: AttachmentMeta): Promise<Attachment>
  getAttachmentUrl(id: string): Promise<string>

  streamAi(req: AiStreamRequest, onEvent: (e: AiStreamEvent) => void): Promise<AbortController>
}
```

`tauri-adapter.ts` calls the existing 133 `invoke()`s. `http-adapter.ts` calls
`apps/api`. Web build only ships `http-adapter.ts`; desktop ships both and
chooses at runtime based on whether the user signed in to a hosted workspace.

### Web auth flow

1. App loads, no token → redirect to `/auth/oidc/default` (Authentik fallback).
2. After callback, the API sets a httpOnly refresh-token cookie and returns a
   short-lived JWT in the response body. The SPA stores the JWT in memory only.
3. The fetch wrapper auto-refreshes on 401 by calling `POST /auth/refresh`.
4. SSE connections include the JWT as a query param (EventSource cannot set
   headers); the API enforces it the same way.

### What gets stripped from the web build

- The whole `src-tauri/` integration, all `@tauri-apps/*` imports.
- Git status bar, conflict resolution UI, AutoGit settings.
- CLI agent runtimes (Claude/Codex/Gemini/OpenCode/PI) — replaced by the
  server-side AI proxy.
- `mock-tauri/` scaffolding — the HTTP adapter is the real backend in tests.

A Vite plugin alias swaps `@tauri-apps/api` for a stub that throws if invoked,
so any forgotten desktop-only call surface fails loud.

---

## 7. AI proxy (LiteLLM)

LiteLLM runs as its own container and is the only thing that holds upstream
model API keys. The API server speaks to it over HTTP with a service token.
Per-subscription model registries map a model name to a LiteLLM route with a
budget tag, so cost can be attributed and capped per tenant.

```
Browser → /ai/chat (JWT) → API (auth + RLS) → LiteLLM (service token) → Provider
```

Model selection rules:

1. If the subscription has a row in `ai_models` matching the requested name,
   use that route + budget tag.
2. Else fall back to a platform-default model (`subscription_id IS NULL`).
3. Reject if neither exists or the model is disabled.

Streaming events are forwarded as-is. Tool calls (web search, vault search,
note-write) round-trip through the API: the model emits a tool call, the API
runs it under the requesting user's RLS context, and returns the result to
LiteLLM to feed back into the stream.

---

## 8. Background worker (`pg-boss`)

Why pg-boss: we already have Postgres, we want exactly-once semantics for
indexing and rename propagation, and we don't want to introduce Redis. pg-boss
gives us delayed jobs, retries with backoff, and visibility timeouts on top of
the same database — including under the same RLS policies, since each handler
calls `withTenant(subscriptionId, …)` before running.

Initial job kinds:

- `index-note`              recompute tsvector + embedding for one note.
- `rebuild-vault-index`     full reindex of a vault.
- `propagate-rename`        update wikilinks across notes after a rename.
- `ai-tool-run`             long-running agent step (e.g. summarize 50 notes).
- `r2-gc`                   delete orphaned attachments after grace period.

The API enqueues; the worker consumes. Workers scale independently.

---

## 9. Security model

- Per-row RLS, enforced in Postgres, set via `SET LOCAL` per request — see §4.
- All secrets (`AUTH_JWT_SECRET`, `LITELLM_TOKEN`, `R2_*`, `AUTHENTIK_*`,
  `DATABASE_URL`) load via Zod-validated `env.ts`. The process refuses to
  start with missing or weak values (e.g. JWT secret <32 bytes).
- JWT lifetime: 10 min access, 30 day refresh (httpOnly, Secure, SameSite=Lax).
- Rate limits: per-IP on `/auth/*`, per-user on `/ai/*` and `/search`. Stored
  in Postgres (no Redis dep) using a token-bucket table.
- Audit log entry for: login, vault create/delete, sso provider mutation,
  AI run start, attachment upload, rename, member role change.
- File uploads: presigned PUT to R2 only after server validates content-type
  and size. SHA256 returned by the client is verified by an R2 head-object
  check before the attachment row's `verified_at` is set.
- Content-Security-Policy: `default-src 'self'; img-src 'self' R2 host;
  connect-src 'self' R2 host LiteLLM-host`. The Tauri inline-eval allowance
  is **not** present in the web build.
- OIDC PKCE everywhere. Implicit/hybrid flows are not offered.

---

## 10. Migration strategy from desktop

Existing desktop users do not lose anything — the desktop app keeps writing to
disk. To opt into the SaaS:

1. Owner creates a subscription on the web app (Authentik login).
2. From desktop, `File → Sync vault to Tolaria Cloud` enumerates `*.md`,
   POSTs each note via `POST /vaults/:id/notes` (idempotent on `slug`), and
   uploads attachments via the same R2 presign flow.
3. Once mirrored, desktop flips the active vault to `mode: synced` and from
   then on writes go through the HTTP adapter instead of Rust filesystem
   commands. Local Git stays as a backup.

There is no automatic two-way sync in v1 — synced vaults are server-canonical.

---

## 11. Phased delivery

This is a 6-week effort at one engineer; with a small team in parallel
streams it compresses to ~3 weeks. Each phase ends with something demoable.

| # | Phase | Outcome |
|---|---|---|
| 1 | Foundations (this commit) | Plan + ADRs + monorepo + RLS schema + API skeleton (healthz, JWT mw, RLS mw) + worker skeleton. |
| 2 | Auth slice | OIDC PKCE login against Authentik, `/me`, JWT refresh, audit log writes. |
| 3 | Vault CRUD slice | `/vaults`, `/notes` CRUD with optimistic versioning. `HttpVaultAdapter` reads/saves a single note end-to-end in the web build. |
| 4 | Search + rename + folders | `tsvector` index via worker, prefix mode, atomic wikilink rename. |
| 5 | Attachments | R2 presign, server-side verify, SPA upload. |
| 6 | AI proxy | LiteLLM container, `/ai/chat` SSE, per-subscription registry, credit metering. |
| 7 | SSO admin UI | Owner can add/remove providers, JIT provisioning. |
| 8 | Web build polish | Strip Tauri imports, hosted-mode UX, error states, rate-limit UI. |
| 9 | Migration tool | Desktop `Sync vault to Cloud` flow. |

Each phase ships behind a `WEB_SAAS_ENABLED` feature flag so the desktop
experience is never destabilized.

---

## 12. Out-of-scope follow-ups

- E2E encryption (vault key derived from passphrase, server stores ciphertext).
- Realtime collaboration (Yjs over WebSocket; needs a separate doc).
- Native mobile clients reusing the same HTTP API.
- Self-hosted single-tenant install (drop the `subscription_id` columns and
  RLS — same code path as the multi-tenant API with a fixed subscription).
