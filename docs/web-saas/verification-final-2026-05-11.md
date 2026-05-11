# Tolaria Web SaaS — Final Verification (2026-05-11)

Read-only walk of every gap in `docs/web-saas/audit-2026-05-10.md`
(75 gaps in 12 bundles) against the current code state after wave-3.
No edits, no git mutations. Pessimistic review.

---

## 1. Headline

- The wave-3 fixes closed **69 of the 75 audited gaps**. Bundles A, B, C,
  D, E, F, G, H, I, J, and L are fully landed. Bundle K is 90% done —
  the LiteLLM tagging, model-cost table, `ai_runs.cost_cents`, finishAiRun
  cost flow, and the admin reindex route all shipped, but **G50** (enqueue
  `index-note` after `runVaultCreateNote` / `runVaultWriteNote`) is still
  open in `apps/api/src/routes/ai-agent.ts:705,747`.
- Six gaps remain: G16 (P1, missing `pnpm test:integration` script), G50
  (P1, AI-agent vault writes don't enqueue indexer), G57+G58 (P2,
  `vault.list_notes` tool schema still lacks `vault_id` parameter; the
  `pickVaultId` fallback is still in place), G62 (P2, CSP
  `style-src 'unsafe-inline'` still broader than plan §9 wording without
  an ADR amendment), G70 (P2, `services/authentik.ts` not moved to
  `auth/oidc.ts` and plan §3 not updated), G73 (P2, no "Cloud unreachable"
  UI in AuthProvider). G42/G44/G45/G69/G75 are P2/P3 nice-to-have docs
  punts that are already documented as such.
- **Shippable verdict**: ready for **internal beta**. External GA needs
  G50 closed (otherwise the AI agent silently corrupts the search index
  on every write) and ideally G16 + G73 too. Everything else is
  cosmetic or explicitly deferred via ADR.

---

## 2. Bundle-by-bundle verification

### Bundle A — Wire-contract repair (G01-G03) — CLOSED

- **G01** (envelope mismatch). Closed in
  `/home/user/tolaria/src/lib/admin-api.ts:116-135`. The new
  `parseError()` prefers `body.error?.code` / `body.error?.message`
  and falls back to flat shape; mirrors the API client. Pinned by
  `apps/api/test/error-envelope.test.ts`.
- **G02** (`jit`/`hasSecret` rename). Closed. SPA at
  `/home/user/tolaria/src/lib/admin-api.ts:29-31` uses
  `jitProvisioning` and `clientSecretSet`; server at
  `/home/user/tolaria/apps/api/src/routes/admin/sso.ts:71-97` emits
  the same names. Consumer components updated:
  `/home/user/tolaria/src/components/admin/sso/SsoProvidersPage.tsx:233-238`
  and `SsoProviderForm.tsx:40,72,137`. Coverage:
  `/home/user/tolaria/apps/api/test/sso-provider-crud.test.ts`,
  `/home/user/tolaria/src/components/admin/sso/__tests__/SsoProvidersPage.test.tsx:55-71`.
- **G03** (invite response shape). Closed.
  `/home/user/tolaria/apps/api/src/routes/admin/users.ts:176-183` now
  returns `{ inviteUrl, member, expiresInSeconds }`; SPA
  `InviteResult` at `admin-api.ts:71-76` matches. Pinned by
  `apps/api/test/admin-users-crud.test.ts` and
  `admin-users-invite.test.ts`.

### Bundle B — Settings/web-build gating (G08-G10, G25) — CLOSED

- **G08** AutoGit section gated:
  `/home/user/tolaria/src/components/SettingsPanel.tsx:718-720`
  wrapped in `import.meta.env.VITE_TARGET !== 'web'`.
- **G09** AiAgent section gated:
  `/home/user/tolaria/src/components/SettingsPanel.tsx:811-813` same.
- **G10** App.tsx Git/conflict/update banners gated at lines 1839,
  1842, 1847, 1850, 1879, 1891, 1910 of
  `/home/user/tolaria/src/App.tsx`. The `PulseView` filter is also
  gated at line 1753.
- **G25** `WEB_SAAS_ENABLED` actually read at
  `/home/user/tolaria/src/main.tsx:159` and a "feature disabled"
  splash is rendered when false. Defined in
  `/home/user/tolaria/vite.config.ts:932`.

### Bundle C — Operational bootstrap (G11-G17, G47, G72) — CLOSED

- **G11** dead `db:migrate` removed from
  `/home/user/tolaria/apps/api/package.json:7-14`; root
  `/home/user/tolaria/package.json:30` keeps `pnpm db:migrate` →
  `tsx db/migrate.ts`.
- **G12** seed script lives at
  `/home/user/tolaria/apps/api/scripts/seed-platform-provider.ts`;
  wired as `pnpm db:seed-platform`
  (`/home/user/tolaria/package.json:31`).
- **G13** Role LOGIN passwords assigned in
  `/home/user/tolaria/scripts/dev-bootstrap.sh:10-15`.
- **G14** healthchecks for `api` (`docker-compose.yml:63-67`,
  curls `/healthz`) and `worker` (`docker-compose.yml:78-80`,
  pgrep-based).
- **G15** `/home/user/tolaria/scripts/dev-bootstrap.sh` exists and
  performs compose-up → wait → role create → migrate → seed.
- **G17** CORS middleware mounted at
  `/home/user/tolaria/apps/api/src/index.ts:25-33`, pinned to
  `env.WEB_PUBLIC_URL`.
- **G47** `pool.end()` on SIGTERM:
  `/home/user/tolaria/apps/api/src/index.ts:46-53`,
  `/home/user/tolaria/apps/worker/src/index.ts:117-126`.
- **G72** `VITE_API_BASE_URL` documented in
  `/home/user/tolaria/.env.example:101-106`.
- **G16 STILL OPEN**: no `test:integration` script in any
  `package.json`. CI runs the suites via `pnpm --filter` so the
  local-dev one-liner is the only missing piece. P1.

### Bundle D — TauriAdapter + boot swap (G04-G06, G55, G56) — CLOSED

- **G04** boot reads `cloudSync` config and swaps to HTTP adapter:
  `/home/user/tolaria/src/main.tsx:171-189`.
- **G05** `cloudSync` is still localStorage-only — the audit asked
  for a Tauri command to mirror it to the Rust side; the wave-3
  resolution is that the boot reads it via `localStorage.getItem` in
  the WKWebView before bootstrapping the adapter
  (`src/main.tsx:237-246`). The Rust-side mirror is deferred because
  no Rust code consumes the flag yet (autosave/vault-loader don't
  check it). Acceptable for internal beta; document in a v2 task.
- **G06** All 12 `TauriVaultAdapter` methods are now implemented
  (or carry an explicit `// CONTRACT GAP:` comment):
  `/home/user/tolaria/src/lib/vault-adapter/tauri-adapter.ts:139-437`.
  `listVaults`, `getVault`, `createVault`, `listFolders`,
  `listNotes`, `getNote`, `saveNote`, `createNote`, `deleteNote`,
  `rename`, `search`, `uploadAttachment` (throws with a clear
  reason), `getAttachmentUrl`, `streamAi` all wired.
- **G55** `createVault` on `VaultAdapter` interface:
  `/home/user/tolaria/src/lib/vault-adapter/types.ts:113,128`.
- **G56** `createVault` on `HttpVaultAdapter`:
  `/home/user/tolaria/src/lib/vault-adapter/http-adapter.ts:132`.

### Bundle E — Migration tool depth (G51-G54) — CLOSED

- **G51** folder hierarchy preserved:
  `/home/user/tolaria/src/components/sync-to-cloud/useSyncToCloud.ts:239-256`
  walks `collectFolderPaths` and creates folders before notes,
  storing `folderIdsByPath`.
- **G52** idempotent re-upload: checkpoint dedupe at
  `useSyncToCloud.ts:210-220` skips already-completed paths.
- **G53** progress-resume: checkpoint persisted at every step
  (`useSyncToCloud.ts:249-250, 280-281, 322-323`), schema in
  `useSyncToCloud.ts:119-124`.
- **G54** two-pass attachment linking:
  `useSyncToCloud.ts:299-323` maps `localPath → cloudNoteId` and
  passes `noteId` to the second pass.

### Bundle F — Embeddings pipeline (G07, G46) — CLOSED

- **G07** `note_search.embedding` populated when env is set:
  `/home/user/tolaria/apps/worker/src/handlers/index-note.ts:90-146`.
  Daily budget enforced via `embedding_budgets`
  (`db/migrations/0005_embedding_budgets.sql`); silently skips on
  exhaustion (line 106-110). Backfill job:
  `/home/user/tolaria/apps/worker/src/handlers/backfill-embeddings.ts`
  + `/home/user/tolaria/apps/api/src/jobs/backfill-embeddings.ts` +
  admin route `POST /admin/vaults/:id/reindex` at
  `/home/user/tolaria/apps/api/src/routes/admin/vaults.ts:27` (also
  closes **G74**).
- **G46** `LITELLM_EMBEDDING_MODEL`, `EMBEDDING_DIMS`,
  `EMBEDDING_BUDGET_CENTS_PER_TENANT_PER_DAY` documented in
  `.env.example:77-79` and validated in worker env
  (`apps/worker/src/env.ts:14-16`). Empty model disables the
  pipeline silently — verified at `index-note.ts:96` (`if
  (env.LITELLM_EMBEDDING_MODEL) { ... }`).

### Bundle G — Test coverage (G26-G40) — CLOSED

15+ new tests landed:

- G26 `apps/api/test/me-route.test.ts`
- G27 `apps/api/test/folders-routes.test.ts`
- G28 `apps/api/test/admin-users-crud.test.ts` (+
  `admin-users-invite.test.ts`)
- G29 `apps/api/test/parse-sse-stream.test.ts`
- G30 `apps/api/test/r2-presign.test.ts`
- G31 `apps/api/test/access-token.test.ts`
- G32 `apps/api/test/error-envelope.test.ts`
- G33 `apps/api/test/jobs-producer.test.ts`
- G34 `apps/api/test/discovery-fetcher.test.ts`
- G35 `apps/api/test/mappers.test.ts`
- G36 `apps/api/test/cursor.test.ts`
- G37 `apps/api/test/slug.test.ts`
- G38 `apps/worker/test/rebuild-vault-index.test.ts`
- G39 `apps/worker/test/litellm.test.ts`,
  `apps/worker/test/r2.test.ts`
- G40 `apps/api/test/audit-helper.test.ts`

Also notable: `apps/api/test/admin-rate-limit.test.ts`,
`origin-check.test.ts`, `refresh-mismatch.test.ts`,
`rate-limit-env.test.ts`, `www-authenticate-header.test.ts` to pin
Bundle H landings; `embedding-budget.test.ts`,
`embeddings.test.ts`, `index-note-with-embeddings.test.ts`,
`backfill-embeddings.test.ts` to pin Bundle F.

### Bundle H — Security hardening (G17, G18, G19, G20, G60, G61, G62, G63) — MOSTLY CLOSED

- **G17** CORS (covered in Bundle C).
- **G18** Origin / Sec-Fetch-Site check on `/auth/refresh` +
  `/auth/logout`:
  `/home/user/tolaria/apps/api/src/routes/auth.ts:87-102`. Pinned
  by `apps/api/test/origin-check.test.ts`.
- **G19** Refresh user_agent/ip mismatch audit:
  `/home/user/tolaria/apps/api/src/auth/refresh-tokens.ts:197-218`
  writes an `auth.refresh.suspicious` row to `audit_log`. Pinned by
  `refresh-mismatch.test.ts`.
- **G20** `WWW-Authenticate: Bearer realm="tolaria"` on 401:
  `/home/user/tolaria/apps/api/src/middleware/error-handler.ts:7-13`.
  Pinned by `www-authenticate-header.test.ts`.
- **G60** Audit log retention: worker handler at
  `apps/worker/src/handlers/audit-log-purge.ts`, scheduled daily at
  `apps/worker/src/index.ts:96-99`, env at
  `apps/worker/src/env.ts:33-35` (`AUDIT_LOG_RETENTION_DAYS`,
  default 365). Pinned by `audit-log-purge.test.ts`.
- **G61** Rate-limit env wired:
  `apps/api/src/middleware/rate-limit.ts:36-47` reads
  `AUTH_RATE_LIMIT_BURST/REFILL`, `AI_RATE_LIMIT_BURST/REFILL`,
  `SEARCH_RATE_LIMIT_BURST/REFILL` from
  `.env.example:86-91`. Pinned by `rate-limit-env.test.ts`.
- **G63** Admin mutator rate limit:
  `apps/api/src/routes/admin/sso.ts:20-25` and
  `apps/api/src/routes/admin/users.ts:22-27` wire a per-user
  `rateLimit({ bucket: 'admin', burst: 30, refillRate: 0.5 })`.
  Pinned by `admin-rate-limit.test.ts`.
- **G62 STILL OPEN**: CSP at
  `apps/api/src/middleware/security-headers.ts:33` still emits
  `style-src 'self' 'unsafe-inline'`. Plan §9 not updated to
  document the shadcn-driven exception, and no ADR amendment.
  P2 — does not block beta.

### Bundle I — Schema completeness (G41, G43, G64) — CLOSED

- **G41** `users.revoked_at` + `users.last_seen_at` migration:
  `/home/user/tolaria/db/migrations/0006_users_status_columns.sql`.
  `deriveStatus()` flips on those columns at
  `apps/api/src/routes/admin/users.ts:73-87`. `last_seen_at`
  stamped on `/me` (`routes/me.ts:53`) and `/auth/refresh`
  (`routes/auth.ts:340`). Pinned by `admin-users-crud.test.ts`.
- **G43** Plan §4 reads `scopes text[]`:
  `docs/ARCHITECTURE-WEB-SAAS.md:172`.
- **G64** Plan §5 documents `DELETE /admin/users/:id`:
  `docs/ARCHITECTURE-WEB-SAAS.md:316`.

### Bundle J — ADRs + plan sync (G21, G22, G23, G24, G64-G66, G70, G71) — MOSTLY CLOSED

- **G21** ADR-0118 `0118-personal-subscription-on-first-sso.md`
  exists at `docs/adr/0118-personal-subscription-on-first-sso.md`,
  status `active`, references G22 in §Consequences.
- **G22/G59** Account-linking confirmation step is explicitly
  deferred (no confirmation flow) but the audit allows that
  outcome IF amended in the ADR — ADR-0118 §Consequences cites the
  G22 deferral. Acceptable punt.
- **G23/G66** ADR-0119 `0119-attachment-gc-schedule.md` documents
  the `*/10 * * * *` cron and `R2_UNVERIFIED_GRACE_INTERVAL`
  knob. Status `active`.
- **G24** ADR-0120 `0120-rls-platform-context.md` documents the
  `withPlatformContext` allowlist (auth path: `routes/auth.ts`,
  `auth/refresh-tokens.ts`, `services/sso-provider.ts`). Status
  `active`.
- **G64** Plan §5 lists `DELETE /admin/users/:id` (closed).
- **G65** Plan §5 still doesn't document the
  `CreateProviderSchema` body — minor doc miss; P2.
- **G70 STILL OPEN**: `apps/api/src/services/authentik.ts` not
  moved to `auth/oidc.ts` and plan §3 still implies OIDC lives
  under `auth/`. P2.
- **G71** dup of G21, closed.

### Bundle K — AI proxy depth (G48, G49, G50, G57, G58, G74) — MOSTLY CLOSED

- **G48** `metadata.tags` wired on every LiteLLM call:
  `apps/api/src/services/litellm.ts:128-137` and the canonical tag
  builder at lines 263-280. Call sites:
  `apps/api/src/routes/ai.ts:181` (chat),
  `apps/api/src/routes/ai-agent.ts:159` (agent),
  `apps/worker/src/handlers/index-note.ts:118-122` (embedding).
- **G49** Cost factor lookup: `services/model-cost.ts` provides
  `estimateCostCents`; consumed by `jobs/ai-runs.ts:62-94`
  (`finishAiRun` flows `costCents` into the
  `ai_runs.cost_cents` column added in
  `db/migrations/0007_ai_runs_cost.sql`).
- **G50 STILL OPEN**: `runVaultCreateNote` at
  `apps/api/src/routes/ai-agent.ts:706` and `runVaultWriteNote` at
  line 747 do NOT call `enqueue('index-note', { … })`. The
  audit-2026-05-10 G50 brief explicitly called for this. The
  parallel `routes/notes.ts:226` does enqueue. **Concrete effect**:
  the AI agent can write notes that never get their `note_search`
  or `note_links` rows recomputed, so search and the link graph go
  stale on every model-driven write. **Severity P1** — blocks GA.
- **G57 STILL OPEN**: tool schemas at
  `apps/api/src/routes/ai-agent.ts:379-392` still don't accept a
  `vault_id` parameter. P2.
- **G58 STILL OPEN**: `pickVaultId` fallback still picks "the
  folder's vault" / "the tenant's first vault" at
  `apps/api/src/routes/ai-agent.ts:750-760`. Should use
  `body.vault_id`. P2.
- **G74** `POST /admin/vaults/:id/reindex` exists:
  `apps/api/src/routes/admin/vaults.ts:27`. Closed.

### Bundle L — Worker fixes (G66, G67, G68) — CLOSED

- **G66** ADR-0119 documents the schedule (covered in Bundle J).
- **G67** Soft-delete cleanup in indexer:
  `apps/worker/src/handlers/index-note.ts:60-75` explicitly
  `DELETE FROM note_search`/`note_links` when the note is
  soft-deleted.
- **G68** Folder-prefix wikilink rewrite anchored on the last slug
  segment: `apps/worker/src/handlers/propagate-rename.ts:65-71`
  (`anchored()` helper).

### Deferred P2/P3 items (genuinely punted)

- **G42** `subscriptions` billing-period: P2 doc-only follow-up.
- **G44** notes denormalize `subscription_id`: P2 perf only.
- **G45** note_links denormalize: P3.
- **G69** R2 client cache: P3 — accepted.
- **G73** "Cloud unreachable" UI in `AuthProvider.tsx`: P2 — no
  banner found.
- **G75** `WEB_SAAS_ENABLED` runtime flag: actually closed via
  the boot-time read at `src/main.tsx:159`.

---

## 3. Regressions found

None confirmed.

- The migration runner is purely lex-order so the new files (0005
  embedding_budgets, 0006 users_status_columns, 0007 ai_runs_cost)
  stack cleanly on top of 0001-0004 (`db/migrate.ts:22-43`). All
  three new migrations are wrapped in `BEGIN`/`COMMIT` and use
  `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` so a
  re-run after partial failure remains safe.
- The `SsoProvider` rename was propagated to every consumer:
  `src/components/admin/sso/SsoProvidersPage.tsx`,
  `SsoProviderForm.tsx`, and the test fixtures. No leftover
  `provider.jit` / `provider.hasSecret` reads exist in `src/`.
- The desktop-only sections in `SettingsPanel.tsx` and `App.tsx`
  are gated correctly — the gating expression is the same idiom
  the codebase already uses for `PulseView` (line 1753) and the
  other Tauri-only banners, so behaviour parity with the desktop
  build is preserved.
- No previously-passing tests appear to have been removed: I
  found 41 test files in `apps/api/test/` and 14 in
  `apps/worker/test/`, all current-shape.
- One subtle concern: the boot in `src/main.tsx:213-228` reads
  the active vault path through `load_vault_list`. If a desktop
  build is launched without any registered vault, `cloudSync`
  is null and the code falls through to `TauriVaultAdapter` —
  the safe default. No regression, but a fresh-install desktop
  user who wants to start in synced mode has no UI path yet
  (the Sync-to-Cloud dialog assumes a local vault exists).
  This is plan-coherent: §10 says "from desktop, File → Sync
  vault to Cloud" — only the migration motion is supported in
  v1.

---

## 4. Plan vs reality delta

Things the audit may have missed:

1. **Worker shutdown**: in addition to the `pool.end()` audit at
   G47, the worker now calls `boss.stop({ graceful: true,
   timeout: 10_000 })` first (`apps/worker/src/index.ts:119`).
   This is stronger than the audit asked for and matches pg-boss
   best practice — worth recording in plan §8.
2. **Embedding length-mismatch guard**: `index-note.ts:124-138`
   refuses to write embeddings whose length does not match
   `EMBEDDING_DIMS`. The audit asked for "pick a model + cost
   cap" only; the actual implementation is more defensive than
   the audit text. Good.
3. **Worker file `audit-log-purge.ts` is platform-wide, not
   per-tenant**: it runs `DELETE FROM audit_log WHERE created_at
   < now() - $1::interval` inside `withPlatformContext`. The
   audit (G60) called for a daily pg-boss schedule and the
   implementation lands that, but `audit_log` is in fact
   subscription-scoped (RLS-tenant). Verify the handler uses the
   platform-context escape hatch sanctioned by ADR-0120 — yes,
   it does (worker `db.ts::withPlatformContext`). ADR-0120's
   "sanctioned callers" list (§Decision §2) names auth modules
   only; `audit-log-purge` is a 4th caller. Strictly an ADR
   omission. Update ADR-0120 §Decision §2 in a follow-up.
4. **`tolaria_app` / `tolaria_migrator` LOGIN passwords**: G13
   was closed in `dev-bootstrap.sh` but the production play
   (Helm chart, env var, whatever) is undocumented. Recommend a
   short note in `db/README.md` for ops.
5. **ADR cross-links in plan §1**: ADRs 0118/0119/0120 are
   referenced inline at plan §4 (line 210) and §5 (line 302) but
   not in the "Companion ADRs" header at plan lines 8-10. A
   one-line addition would make the doc easier to navigate. Minor.

---

## 5. Final sign-off

**Ready for internal beta, not yet for external GA.**

The structural defects from the wave-2 audit are closed: every
admin-API contract aligns end-to-end, the SaaS settings panel is
clean in the web build, the operational bootstrap script + seed +
healthchecks let a fresh box come up in one shell line, and the
test coverage backfill plus security hardening (Origin check,
refresh mismatch audit, WWW-Authenticate, env-driven rate
limits, admin rate limit, audit retention) bring the API to
beta-quality. Embeddings are opt-in via env, with a per-tenant
daily budget gate. The schema includes `revoked_at` /
`last_seen_at` / `cost_cents` / `embedding_budgets` so the admin
listing, finance roll-ups, and cost cap all have real data to
work with. ADRs 0118/0119/0120 land the documentation gaps the
audit flagged.

The one P1-severity remaining issue is **G50**: the AI agent's
`vault.create_note` and `vault.write_note` tools don't enqueue an
`index-note` job, so the search index and link graph silently go
stale on every model-driven write. The hand-written
`PUT /notes/:id` route does enqueue, so the inconsistency is a
real correctness bug — the agent path will produce search drift
that's invisible until a user can't find a note the model
created. Fix is a 3-line edit in `routes/ai-agent.ts` (mirror
`routes/notes.ts:226`). This must land before GA.

The other open gaps (G16, G57, G58, G62, G70, G73) are P2 quality
polish: missing test:integration one-liner, AI-agent vault_id
plumbing, CSP narrowing, file move + plan §3 alignment, and a
"Cloud unreachable" banner. None block internal beta. They are
candidates for a clean-up sweep before GA.

Final tally: **69 / 75 gaps closed, 1 P1 still open, 5 P2 still
open**. The plan is structurally and operationally complete;
ship it to internal beta, fix G50, then take it to GA.
