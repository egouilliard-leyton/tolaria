---
type: ADR
id: "0118"
title: "Personal subscription auto-created on first SSO login"
status: active
date: 2026-05-11
---

## Context

The Tolaria web SaaS uses the platform-default Authentik provider (see
ADR-0117 §5) as the public sign-in route for new individual users. When
a brand-new user lands on `/auth/oidc/default/start`, completes the
upstream OIDC handshake, and returns through the callback, there is no
pre-existing `users` row — the JIT-provisioning path in
`apps/api/src/routes/auth.ts::jitProvisionUser` must invent both the
user record *and* a tenant for it to live in. ADR-0115 requires every
`users` row to carry `subscription_id`, so we cannot create the user
without first deciding which subscription is theirs.

Three options were considered:

1. **Block first-time SSO on an admin gate**. Strong audit trail, but
   the platform default is meant for individual self-signup; an admin
   gate makes the free tier feel like a managed product. Wrong shape
   for the personal-vault use case the desktop app already serves.
2. **Drop the user into a shared "platform tenant"**. Simple, but
   immediately violates the RLS isolation contract — every individual
   user would share a single `subscription_id` and could read each
   other's notes through any future query that forgets `created_by`.
   Unacceptable.
3. **Auto-create a personal subscription and stamp the user as its
   owner**. Zero-friction onboarding; the new tenant lands in its own
   RLS scope from the very first request. Upgrade path is "owner adds
   team members + flips the plan via the admin UI" — same path a paid
   subscription uses, just unlocked.

## Decision

**On first sign-in through the platform-default Authentik provider, the
API auto-creates a personal subscription named after the user's email
and stamps the user as its `role='owner'`. Per-subscription providers
keep their existing JIT semantics — they only mint users into the
subscription that owns the provider.**

Specifics:

1. `apps/api/src/routes/auth.ts::jitProvisionUser` checks
   `provider.subscriptionId`. If `null` (platform default), it calls
   `ensurePersonalSubscription(claims)`, which `INSERT`s a
   `subscriptions` row with `name = "Personal — <email>"` and
   `plan = 'free'`, then returns the new id.
2. The user row is then inserted under that fresh subscription with
   `role = 'owner'`. Per-subscription providers stamp
   `provider.defaultRole` instead.
3. The first request after callback is already inside `withTenant`
   bound to the new subscription, so RLS is honest from byte one.
4. Both writes happen via `withPlatformContext` (see ADR-0115 + the
   new ADR-0120) — at this point we have no resolved
   `app.subscription_id` to switch into yet. The platform context is
   the only sanctioned escape hatch for this exact bootstrap moment.

## Alternatives considered

- **Admin gate on first SSO** (rejected): wrong product shape for the
  individual free tier.
- **Shared platform tenant** (rejected): collapses RLS isolation; one
  forgotten predicate would leak across every free-tier user.
- **Mint a placeholder subscription and defer naming to a follow-up
  step** (deferred): would require a multi-step onboarding flow we do
  not have UI for. Naming after the email is good enough for v1 and
  the admin UI lets the new owner rename it later.

## Consequences

- **Multiplicity** is expected: a user who has both a personal
  Authentik account and a corporate Entra ID provider will land in
  *two* subscriptions, one per provider. Account linking (ADR-0117 §6)
  is what merges them; until linking lands behind a confirmation step
  (audit G22), duplicate rows are the safe default.
- The admin listing shows the personal subscription with its
  human-readable name (`Personal — alice@example.com`), so the owner
  can rename it once they want a team.
- Billing follow-up: the personal subscription stays on `plan='free'`
  until the owner upgrades. The plan upgrade is a separate motion (out
  of scope for this ADR) but the schema already accommodates it via
  `subscriptions.plan`.
- This is the *only* code path that creates a `subscriptions` row in
  the public API. Admin tooling that bootstraps a tenant explicitly
  (e.g. enterprise sales) goes through an out-of-band script, not the
  request path.
- Audit: `auth.login.success` is written under the new subscription's
  RLS context immediately after the row is inserted, so the personal
  subscription has provenance from its first second.
