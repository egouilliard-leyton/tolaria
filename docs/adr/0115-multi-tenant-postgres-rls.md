---
type: ADR
id: "0115"
title: "Multi-tenant Postgres with row-level security"
status: active
date: 2026-05-09
---

## Context

The Tolaria desktop app stores everything on the local filesystem, so tenant
isolation is whatever the OS gives us. The web SaaS port (see
`docs/ARCHITECTURE-WEB-SAAS.md`) hosts many subscriptions in a single
Postgres cluster, which makes isolation a deliberate choice. Three options
were considered:

1. One Postgres database per tenant — strong isolation, but operationally
   expensive (migrations × N, connection-pool fragmentation, awkward
   cross-tenant analytics) and hostile to a low-spend free tier.
2. Shared schema with `WHERE subscription_id = $1` everywhere — simple, but
   one missing predicate in any of the dozens of upcoming queries silently
   leaks data across tenants. The blast radius is unacceptable for a notes
   product where the data is mostly text people consider private.
3. Shared schema with Postgres row-level security plus a per-request session
   variable — the planner appends the policy automatically, so an accidental
   omission cannot leak anything. Cross-tenant analytics still work via a
   privileged role that bypasses RLS.

The same database is consumed by both `apps/api` (request-scoped) and
`apps/worker` (job-scoped). Both must enforce the same isolation without
duplicating the rule.

## Decision

**Tolaria's web SaaS uses a shared Postgres database with row-level security
enabled on every tenant-owned table. Tenant context is supplied per request
via `SET LOCAL app.subscription_id = …` inside a transaction.**

Specifics:

1. Every tenant-owned table carries `subscription_id uuid not null` and a
   policy of the form
   `USING (subscription_id = current_setting('app.subscription_id')::uuid)`.
2. The application connects as a non-privileged role for which RLS is
   enforced (`FORCE ROW LEVEL SECURITY` is set on tenant tables so even the
   table owner is policy-bound). A separate `migrator` role applies DDL.
3. `apps/api` opens a transaction per request, calls
   `SET LOCAL app.subscription_id = $1` and `SET LOCAL app.user_id = $1`,
   runs the request handler, then commits. `SET LOCAL` is cleared at COMMIT
   so a returned connection never leaks tenant context.
4. `apps/worker` follows the same pattern: each job carries
   `subscription_id` in its payload, and the handler wraps its work in
   `withTenant(subscriptionId, …)` before issuing any query.
5. RLS-bypassing reads (admin tooling, billing rollups, cross-tenant analytics)
   run as a privileged role that explicitly opts in via
   `SET LOCAL ROLE platform_admin`, and only from out-of-band scripts — never
   from the public API.
6. A first-class platform fallback for `sso_providers` and `ai_models` is
   modelled as `subscription_id IS NULL` rows, which the policy permits to
   any session (read-only). This avoids inventing a "platform tenant" sentinel.

## Alternatives considered

- **Per-tenant database** (rejected): operational cost, migration fanout,
  poor fit for a free tier with thousands of small tenants.
- **App-layer scoping with `WHERE subscription_id = $1` only** (rejected):
  the failure mode is silent cross-tenant disclosure on a single missed
  predicate. Code review is not a sufficient safety net at the size we
  expect this surface to grow.
- **Logical replication slot per tenant for analytics** (rejected for now):
  premature; the privileged-role escape hatch is enough for v1.

## Consequences

- Every new tenant-owned table must include `subscription_id` and an RLS
  policy. A migration linter check enforces this in CI.
- The RLS context guard (`withTenant`) is the single chokepoint for issuing
  queries. Direct `pool.query` from a route handler is forbidden by an ESLint
  rule.
- Background jobs must serialize `subscription_id` into their payload —
  pg-boss is fine for this because it stores payloads as JSONB.
- Schema changes that introduce new tenant-spanning queries (cross-tenant
  joins, global counters) must explicitly run as the privileged role and be
  reviewed.
- Tests for routes always run end-to-end against a real Postgres with RLS
  on, so policy regressions are caught at CI time.
