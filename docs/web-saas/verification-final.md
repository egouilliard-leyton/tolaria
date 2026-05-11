# Tolaria Web SaaS — Final Verification (2026-05-10)

Read-only post-integration review against
`docs/ARCHITECTURE-WEB-SAAS.md`, ADRs 0115/0116/0117, and the prior
report `docs/web-saas/verification-2026-05-09.md`. No code or git
mutations were performed.

---

## 1. Headline

- **How complete is the plan?** Structurally, ~90%. Every plan phase has
  landed code: routes are mounted, the worker has real (non-stub)
  handlers for all five queue kinds, RLS + FORCE RLS is on every tenant
  table, R2 presign+verify is wired, OIDC PKCE start/callback/refresh is
  shipped, AI `/ai/chat` + `/ai/agent/run` SSE proxy + per-subscription
  model registry work, SSO admin UI + sync-to-cloud + web build target
  all exist. The five blockers from the 2026-05-09 report are resolved
  (route mounting, snake_case wire alignment for the vault adapter,
  discovery-cache TTL, audit-log gaps on vault/attachment/rename, real
  `/readyz` probes).
- **What's still missing?** A handful of contract mismatches between
  the API JSON and the SPA's clients survived the alignment pass —
  most critically the auth-completion redirect uses the URL **fragment**
  while the SPA reads `searchParams`, so SSO login installs no token.
  Admin endpoints wrap their responses in `{ provider: … }` /
  `{ user: … }` envelopes that the SPA's `admin-api.ts` does not
  unwrap. The auth route trusts `X-Forwarded-For` unconditionally for
  audit-log IPs, bypassing the `TRUST_PROXY` guard the rate-limiter
  honors. Embeddings (pgvector) are still a TODO in `index-note`.
- **Shippable as v1?** Not yet. The auth-fragment defect is a 100%
  reproducible login break and must land before any external user
  can sign in. The admin-envelope mismatch breaks the SSO admin UI.
  With those two fixed and the IP-spoofing tightened, the rest is
  in good enough shape for an internal-preview release.

---

## 2. Phase-by-phase verdict

### A. Plan §11 — phased delivery

| # | Phase | Verdict |
|---|---|---|
| 1 | Foundations | ✅ — `apps/api`, `apps/worker`, `db/migrations/0001_init.sql`, `pnpm-workspace.yaml`, `docker-compose.yml`, `.env.example`, `saas-ci.yml` all present. |
| 2 | Auth slice | ⚠️ — OIDC PKCE start/callback (`apps/api/src/routes/auth.ts:220-280`) + `/auth/refresh` (282-309) + `/auth/logout` (311-319) all real. **Defect:** redirect target uses fragment `…/auth/complete#access_token=…` (auth.ts:278) but SPA parses with `url.searchParams.get('access_token')` (`src/lib/auth/web-auth.ts:51`). Login completion silently no-ops. |
| 3 | Vault CRUD + HttpVaultAdapter | ✅ — `routes/vaults.ts`, `routes/notes.ts`, `lib/mappers.ts` emit snake_case bare arrays / `{ items, next_cursor }` matching `src/lib/vault-adapter/http-adapter.ts`. Optimistic version check at `notes.ts:148-152`. |
| 4 | Search + rename + folders | ✅ — `routes/search.ts` runs both `full` (websearch_to_tsquery + ts_headline) and `prefix` (pg_trgm similarity) modes with worker fallback (90-99). `routes/rename.ts:130-189` does the slug bump + body rewrite inside one transaction. `routes/folders.ts` covers list/create/patch/delete with cycle-prevention CTE. |
| 5 | Attachments | ✅ — `routes/attachments.ts` covers POST presign → POST verify → GET 302 → DELETE soft+gc. R2 client `services/r2.ts:107-153` signs the PUT with `x-amz-meta-sha256`. |
| 6 | AI proxy | ✅ — `/ai/chat` SSE (`routes/ai.ts:77`), `/ai/agent/run` SSE with server-side vault tools (`routes/ai-agent.ts:52-93`, tools at 336-432), `/ai/models` registry (`routes/ai.ts:49-64`), credit decrement via `decrementCredits` and `usage` SSE frame (`ai.ts:201-206`). |
| 7 | SSO admin UI | ⚠️ — Backend `routes/admin/sso.ts` is feature-complete with `requireRole('owner')` and audit writes. **Defect:** POST/PATCH return `{ provider: … }` (sso.ts:154, 234) and DELETE returns `{ deleted: { id } }` (sso.ts:260), but the SPA's `src/lib/admin-api.ts:144-164` expects bare DTOs / 204. |
| 8 | Web build polish | ✅ — `vite.config.ts:893-954` picks `dist-web/` when `VITE_TARGET=web`; `src/lib/web-build/tauri-stub.ts` exists; `pnpm build:web` script in root `package.json:11`. |
| 9 | Migration tool | ✅ — `src/components/sync-to-cloud/{SyncToCloudDialog,useSyncToCloud,CloudSyncSettingsSection}.tsx` implement the three-step sign-in→destination→progress flow against the live adapter. |

### B. Plan §8 — worker handlers

All five queues have **real** handlers (no stubs):

- `index-note` ✅ — `apps/worker/src/handlers/index-note.ts:35-101`. Upserts `note_search.ts_doc` with `to_tsvector('simple', …)` and rebuilds `note_links` (wipe+insert) from the parsed wikilinks. ⚠️ Embeddings still TODO (line 51-54: `embedding` column left NULL).
- `rebuild-vault-index` ✅ — `handlers/rebuild-vault-index.ts:18-42`. Fans out per-note `index-note` jobs.
- `propagate-rename` ✅ — `handlers/propagate-rename.ts:32-44`. Re-enqueues `index-note` for affected ids; falls back to a regex sweep when payload is light.
- `ai-tool-run` ✅ — `handlers/ai-tool-run.ts:42-74`. Real implementations for `summarize-vault` (76-135, calls LiteLLM, writes `ai_runs.output_text`) and `rebuild-graph` (137-172). Unknown tools fail with `unsupported_tool`.
- `r2-gc` ✅ — `handlers/r2-gc.ts:29-89`. Both per-id deletion and `unverified-sweep` mode (selects rows older than `R2_UNVERIFIED_GRACE_INTERVAL`, default '1 hour'). Deletes R2 object then the row.

⚠️ The worker `main()` (`apps/worker/src/index.ts:13-84`) starts handlers but **does not schedule** the `unverified-sweep` periodic — `r2-gc` is only enqueued on user DELETE (`apps/api/src/jobs/r2-gc.ts:30-38`), so abandoned uploads will never be swept until an external scheduler or pg-boss cron hooks them up. ADR-0116 §"unverified rows are GC'd by the worker after 1 hour" is therefore not fully met.

### C. Plan §9 — security cross-cuts

- **Rate limits** ✅ — `middleware/rate-limit.ts:24-138` runs a Postgres token-bucket (UPSERT-with-refill). Wired:
  - `/auth/*` per-IP via `auth.use('/auth/*', rateLimit({ bucket:'auth', scope:'ip', …AUTH_RATE_LIMIT }))` (routes/auth.ts:55-58).
  - `/ai/chat` per-user (`routes/ai.ts:70-77`).
  - `/ai/agent/run` per-user (`routes/ai-agent.ts:52-56`).
  - `/vaults/:vaultId/search` per-user (`routes/search.ts:36-39`).
- **CSP** ✅ — `middleware/security-headers.ts:26-46` mounts CSP as the outermost middleware. `connect-src 'self' <r2 origin> <litellm origin>`, `img-src 'self' <r2 origin> data:`, `frame-ancestors 'none'`. Inline scripts blocked. Health endpoints exempt.
- **Audit log** ✅ (with one caveat). Mutations covered: login success/failure (auth.ts:272, 365, 345), refresh (298), vault create (vaults.ts:65) + delete (123), attachment create (attachments.ts:123), rename (rename.ts:56), sso provider create/update/delete (admin/sso.ts:147, 226, 253), user invite/role/revoke (admin/users.ts:129, 207, 276), AI run start + success/failure (ai.ts:88, 222 & ai-agent.ts:70, 305) and per-tool invocations (ai-agent.ts:458). ⚠️ Member role change is audited only via `admin/users.ts` PATCH; bulk vault membership changes have no dedicated `vault_member.*` audit code path (there is no membership-mutation endpoint at all).
- **Env validation** ✅ — `apps/api/src/env.ts:20-32` refuses `AUTH_JWT_SECRET <32 bytes` and `AUTH_PROVIDER_SECRET_KEY <32 bytes`. `R2_*` and `LITELLM_*` are required `.url()` / non-empty.
- **File-upload sha256 verify** ✅ — `apps/api/src/services/r2.ts:107-153` signs the PUT with the meta header; `routes/attachments.ts:170-193` does `HeadObject` and compares `Content-Length` + sha256 before setting `verified_at`.

### D. Plan §3 — monorepo layout

- `apps/api` ✅, `apps/worker` ✅, `db/migrations/000{1..4}_*.sql` ✅, `.env.example` ✅ (web SaaS section at the bottom).
- `pnpm-workspace.yaml` includes `apps/*` (line 3).
- `pnpm build:web` ✅ (`package.json:11`); web bundle emits to `dist-web/` (`vite.config.ts:952-954`).
- `docker-compose.yml` brings up postgres, authentik, redis, minio, litellm, api, worker.
- `apps/api/Dockerfile` + `apps/worker/Dockerfile` are real multi-stage builds.
- `db/migrate.ts` exists and is idempotent against a `_migrations` table.
- `.github/workflows/saas-ci.yml` runs migrate + api tests + api/worker builds against a postgres service. ⚠️ It does **not** run worker tests (`pnpm --filter @tolaria/worker test` is missing). Worker test files exist under `apps/worker/test/*.test.ts` — they will never run in CI.

### E. Plan §4 — data model

- Every tenant table carries `subscription_id` ✅. Verified in `db/migrations/0001_init.sql` for users (50), sso_providers (71), vaults (96), notes via vaults (146 with cascade), folders via vaults, attachments via vaults, ai_models (235), audit_log (258), refresh_tokens (275), and ai_runs in 0002 (16).
- Every tenant table has `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` ✅ (14 tables, grep confirms).
- Helper functions `app_subscription_id()` / `app_user_id()` present (0001_init.sql:23-31).
- `withTenant` chokepoint exists (`apps/api/src/db.ts:24-42`) and the worker mirrors it (`apps/worker/src/lib/db.ts:36-58`). Every route handler that issues SQL uses it; tested by reading vaults, notes, folders, search, rename, attachments, ai, ai-agent, admin/sso, admin/users, me.
- `withPlatformContext` escape hatch is documented (db.ts:60-97) and used only by `auth/refresh-tokens.ts`, `services/sso-provider.ts`, and `routes/auth.ts` for pre-tenant lookups — appropriate.
- `rate_limit_buckets` table (`db/migrations/0003_rate_limits.sql`) is intentionally **not** RLS-scoped (per-IP rows have no tenant), documented in the file header.

### F. ADR-0116 — attachments

- Bucket layout `s/<sub>/v/<vault>/a/<att>/<filename>` ✅ (`services/r2.ts:65-71`). UUIDs are validated.
- Presigned PUT (5-min TTL) returned by `POST /vaults/:id/attachments` ✅ (routes/attachments.ts:139-148).
- MIME allowlist enforced server-side ✅ (`isAllowedAttachmentMime`, attachments.ts:58-62).
- SHA-256 verification via `HeadObject` ✅ (attachments.ts:170-193); mismatches return 409 with structured reason.
- Async R2 GC ✅ via `r2-gc` queue, with the gap noted in §B.
- R2 credentials confined to API process (env.ts:37-44; never sent to browser).

### G. ADR-0117 — Authentik OIDC SSO

- PKCE-only ✅ (`services/authentik.ts:110-130`; `code_challenge_method: 'S256'`, no implicit/hybrid path).
- Encrypted client_secret ✅ — `lib/crypto.ts` uses AES-256-GCM with `iv(12)||tag(16)||ct` envelope; the legacy duplicate `services/secret-encryption.ts` is now a re-export shim (1-42).
- JIT provisioning toggle honored ✅ — `routes/auth.ts:461-465` rejects with `Forbidden` when `provider.jitProvisioning === false`.
- `requireRole('owner')` on admin/sso routes ✅ (`routes/admin/sso.ts:91`).
- OIDC discovery cache has a 10-min TTL ✅ (`services/authentik.ts:56-85`); failed re-fetches do not poison the cache (74-82).
- Personal-subscription auto-creation on first SSO login (auth.ts:507-523) is implemented but still undocumented in ADR-0117. ⚠️ Same gap the prior report flagged; the ADR text was not updated.
- ⚠️ `clientIp()` in `routes/auth.ts:146-152` (used for audit-log IP recording) reads `x-forwarded-for` / `x-real-ip` **unconditionally**, ignoring the `TRUST_PROXY` env gate that `middleware/rate-limit.ts:85-87` honors. A client behind a non-trusted edge can spoof their audit-log IP. The rate limiter is safe, the audit row is not.

---

## 3. Top 5 remaining defects (severity-sorted)

### 1. ❌ OIDC login completion is broken on the SPA side (Blocker)

- **What:** Server redirects to `${WEB_PUBLIC_URL}/auth/complete#access_token=<jwt>&token_type=Bearer&expires_in=<n>` (`apps/api/src/routes/auth.ts:278`). The SPA reads the token with `url.searchParams.get('access_token')` (`src/lib/auth/web-auth.ts:51`), which only reads the URL **query string**, not the fragment. The token is never installed; the user lands on `/auth/complete` with no session and falls back to the refresh path that has not yet run.
- **Fix:** Either change the server to use `?access_token=…&token_type=…&expires_in=…` (and remove the `#`), or change the SPA to parse `window.location.hash` first. The plan §6 wording ("after callback, the API sets a httpOnly refresh-token cookie and returns a short-lived JWT in the response body") is silent on transport, so either fix is plan-conformant; the fragment is marginally safer (not in Referer, not in server access logs) so prefer fixing `web-auth.ts` to parse the hash. Add an `auth-complete.test.ts` covering both shapes so a future regression breaks loudly.

### 2. ❌ Admin endpoints wrap responses; SPA expects bare DTOs (High)

- **What:** Multiple admin endpoints return `{ provider: … }` / `{ user: … }` / `{ deleted: { id } }` envelopes, but `src/lib/admin-api.ts` types the body as the bare DTO or `void`:
  - `POST /admin/sso/providers` server returns `{ provider }` (sso.ts:154) — SPA expects `SsoProvider` (admin-api.ts:144).
  - `PATCH /admin/sso/providers/:id` server returns `{ provider }` (sso.ts:234) — SPA expects `SsoProvider`.
  - `DELETE /admin/sso/providers/:id` server returns `{ deleted: { id } }` (sso.ts:260) — SPA expects 204/empty.
  - `PATCH /admin/users/:id` server returns `{ user }` (users.ts:214) — SPA expects bare `Member`.
  - `DELETE /admin/users/:id` server returns `{ user }` (users.ts:282) — SPA expects 204.
- **Fix:** Pick one. The simplest is to flatten the server responses to bare DTOs (or 204 for the deletes); that matches the bare-array GET pattern the integration agent already aligned on for `/vaults`, `/folders`, and SSO `GET /providers`. Adjust the four sso.ts + users.ts return sites and add contract tests under `apps/api/test/sso-provider-crud.test.ts` and a new users CRUD test.

### 3. ⚠️ Audit-log IP recording trusts `X-Forwarded-For` unconditionally (High)

- **What:** `routes/auth.ts:146-152` (`clientIp`) returns the leftmost `x-forwarded-for` (or `x-real-ip`) header on every call, regardless of `env.TRUST_PROXY`. The value is then persisted to `refresh_tokens.ip` via `issueRefreshToken(...)` and to `audit_log.meta` (indirectly). The rate-limit middleware already honors `TRUST_PROXY` correctly (rate-limit.ts:85-87) — so the two helpers disagree.
- **Fix:** Replace the local `clientIp` in `routes/auth.ts` with a call to a shared helper (extract one from `middleware/rate-limit.ts:84-97` into `lib/`), so the same `TRUST_PROXY` gate governs both. When `TRUST_PROXY=0`, fall back to the socket remote address via `getConnInfo(c).remote.address`.

### 4. ⚠️ Unverified-attachment sweep is implemented but never scheduled (Medium)

- **What:** ADR-0116 §4 requires unverified rows older than the grace window to be GC'd. The handler exists (`apps/worker/src/handlers/r2-gc.ts:71-89`, `mode: 'unverified-sweep'`), but nothing in `apps/worker/src/index.ts` or `apps/api/src/jobs/index.ts` ever enqueues it on a timer. A user that begins an upload and crashes before `POST /verify` will leave both an R2 object and an attachment row forever.
- **Fix:** Add a pg-boss `schedule` (e.g. `boss.schedule('r2-gc', '*/15 * * * *', { subscriptionId: '<each>', attachmentId: '', mode: 'unverified-sweep' })`) in `apps/worker/src/index.ts`. Iterating over subscriptions in the worker loop is fine because the sweep already runs under each tenant's `withTenant(...)`. Alternative: open it up to a single, RLS-bypassing sweeper that uses `withPlatformContext`. The first option keeps the RLS posture clean.

### 5. ⚠️ Worker tests don't run in CI; `index-note` still leaves embeddings NULL (Medium)

- **What 5a:** `.github/workflows/saas-ci.yml` runs `pnpm --filter @tolaria/api test` and the two `build`s, but never `pnpm --filter @tolaria/worker test`. Worker test files exist (`apps/worker/test/{index-note,r2-gc,propagate-rename,ai-tool-run}.test.ts`) but are essentially dead in the gate.
- **What 5b:** `apps/worker/src/handlers/index-note.ts:51-54` explicitly punts on embeddings — `note_search.embedding` is permanently `NULL` until an embedding strategy lands. Plan §4 lists `embedding vector(1536)` as part of the data model; the schema and the column type exist but nothing populates them. Search is full-text only.
- **Fix:** Add `- run: pnpm --filter @tolaria/worker test` to `saas-ci.yml` after the build step; this catches the index/rename/r2-gc/ai-tool-run regressions the agents wrote tests for. Track the embedding work as an out-of-band ticket (plan §11 doesn't gate v1 on embeddings).

---

## 4. What's beyond the plan (positive deltas)

- **Agent E shipped a server-side agent route** (`/ai/agent/run`) with five built-in vault tools (`vault.search`, `list_notes`, `get_note`, `create_note`, `write_note`) running under `withTenant` (ai-agent.ts:453-731). Plan §5 implies the agent route but only specifies `tools` in the abstract; the server-side execution model with `parallel`/`sequential` modes and a 20-step safety ceiling is a clear upgrade over the §7 sketch.
- **A new migration `0004_ai_tool_runs_output.sql`** adds `ai_runs.output_text` so async tool runs (summarize-vault) can persist their result — not in the plan but necessary for the worker handler.
- **`SYSTEM_USER_ID` zero-UUID convention** in the worker (`apps/worker/src/lib/db.ts:34`) gives audit rows a stable "system actor" when no human triggered the job — cleanly resolves a question the plan left open.
- **Helper `withPlatformContext`** (`apps/api/src/db.ts:77-97`) is well-documented as the auth-path escape hatch with the rationale spelled out. This is more disciplined than the plan asked for.
- **Real `/readyz` checks** with a 2 s `Promise.race` timeout per upstream probe (`routes/health.ts:31-87`) — better than the plan's "DB ping + R2 ping + LiteLLM ping" line.
- **Slug+title humanise helper** in rename (`routes/rename.ts:204-213`) is a nice ergonomic touch.

---

## 5. Final sign-off

The web SaaS port is structurally complete. Every plan phase has landed
real code, RLS is consistently enforced through `withTenant`, the worker
handlers are no longer stubs, and the per-feature security cross-cuts
(rate limits, CSP, audit, presign+verify, env validation) are wired.
The five problems flagged above are concentrated in two areas: a
last-mile contract drift between server and SPA (defects #1 and #2)
and one half-finished operational hook (defect #4). None of them
require a structural redesign — each is a small, localized change with
a clear file:line target. Once defects #1 and #2 land, an internal
beta is plausible; once #3 lands, the audit story is correct in
multi-hop deployments; once #4 and #5 land, the v1 promise of "no
orphaned R2 objects, every worker handler under CI" holds. I would not
ship to external users today, but I would happily ship to a friendly
private beta tomorrow.
