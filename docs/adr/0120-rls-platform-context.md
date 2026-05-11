---
type: ADR
id: "0120"
title: "Sanctioned RLS escape hatch — withPlatformContext (supplement to ADR-0115)"
status: active
date: 2026-05-11
---

## Context

ADR-0115 §2/§3 require that every request runs inside `withTenant`,
which sets `app.subscription_id` so the row-level security policies on
every tenant table evaluate against a concrete tenant. That contract
is the load-bearing safety property of the multi-tenant Postgres
design: a single forgotten predicate cannot leak across tenants.

The OIDC callback path violates the contract by necessity. When the
upstream provider redirects back with a code:

- We have not yet resolved a `users` row (the goal of the callback is
  to find or create one). Without a user, we cannot derive
  `subscriptionId`, so `withTenant` cannot be opened.
- We need to read `sso_providers` rows where `subscription_id IS NULL`
  (the platform-default Authentik fallback) — the ADR-0115 policy
  `sso_providers_tenant_or_global` already permits this for any
  session, so the read works with no session var set.
- We need to look up an existing `users` row by SSO subject *across
  subscriptions* — this is the account-linking lookup. The
  `users_tenant` policy denies the read without a session var, so the
  callback explicitly clears any leftover var and uses the platform
  context.

The current implementation in `apps/api/src/db.ts::withPlatformContext`
opens a transaction, clears `app.subscription_id` and `app.user_id`,
and runs `fn`. The audit flagged that this escape hatch is real but
not called out in ADR-0115 (gap G24), so this ADR records the
guard-rails around it explicitly.

**This is a small supplement to ADR-0115, not a supersession.**
ADR-0115's RLS design remains canonical; this ADR documents the only
sanctioned exit from it.

## Decision

**`withPlatformContext` is the *only* sanctioned escape from
`withTenant`. Its use is restricted to the auth path: modules under
`apps/api/src/routes/auth.ts` and `apps/api/src/services/sso-*.ts`.
Every other module must call `withTenant`. A future ESLint rule should
encode the allowlist.**

Specifics:

1. The helper's contract is documented inline in
   `apps/api/src/db.ts::withPlatformContext`. It opens a transaction,
   explicitly clears `app.subscription_id` and `app.user_id` via
   `set_config(_, '', true)`, runs the callback, and commits.
2. Sanctioned callers (the only ones that may use the helper):
   - `apps/api/src/routes/auth.ts` — OIDC callback + JIT provisioning
     in `jitProvisionUser` and `ensurePersonalSubscription` (the
     latter feeds ADR-0118).
   - `apps/api/src/auth/refresh-tokens.ts` — refresh-token rotation
     needs to read the prior token row before it knows which
     subscription it belongs to.
   - `apps/api/src/services/sso-provider.ts` — platform-default
     provider loader and admin-CRUD pre-flight reads.
3. With no session var set, the visible surface is exactly:
   - `sso_providers` rows where `subscription_id IS NULL` (policy
     `sso_providers_tenant_or_global` permits this for any session).
   - Any other table behaves as if the policy denies the read,
     because `app_subscription_id()` returns NULL and every tenant
     policy is `subscription_id = app_subscription_id()`.
   This is the intended safety margin: the escape hatch grants only
   the platform-default read, plus the targeted user/subscription
   `INSERT`s that the JIT path performs after explicitly setting
   `app.subscription_id` mid-transaction.
4. Once the user identity is resolved, every subsequent query MUST
   switch to `withTenant({ subscriptionId, userId }, …)`. The
   resolution happens before any feature-route runs, so feature
   modules can rely on the tenant context being set.

## Enforcement

- **Code review** is the current enforcement. A linter rule pinned to
  the allowlist above is a follow-up (it cannot land here without a
  separate review of the AST shape it needs to detect).
- **Module placement**: any new caller must justify itself in a PR
  description that names the audit/ADR review it passed. Reviewers
  should reject the PR if the caller is not on the allowlist.
- **Tests**: `apps/api/test/auth-callback.test.ts` exercises the
  platform-context path; `audit-helper.test.ts` and the existing
  tenant-routes tests exercise the normal `withTenant` path. Adding a
  test that asserts `withPlatformContext` is NOT called from any
  route under `apps/api/src/routes/` other than `auth.ts` is a
  reasonable static check to land in a follow-up.

## Consequences

- The escape hatch has a clear, documented boundary. Anyone reading
  ADR-0115 + this ADR understands when and why `withTenant` does not
  cover every code path.
- The auth path remains the only place where cross-tenant reads
  happen, and only against the specific tables whose policies permit
  it (`sso_providers` platform-default, `refresh_tokens` by token
  hash, `users` by SSO subject).
- A future move to a strict per-tenant context (e.g. resolving
  identity *before* opening any DB transaction by carrying the
  refresh-token's `subscriptionId` in the cookie) could retire this
  helper entirely. Until then, the boundary above is the contract.
