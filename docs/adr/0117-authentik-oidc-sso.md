---
type: ADR
id: "0117"
title: "Authentik as default OIDC SSO with per-subscription overrides"
status: active
date: 2026-05-09
---

## Context

The Tolaria web SaaS needs an authentication story that satisfies two
audiences:

1. Individual users on the free tier who just want to "sign in with the
   thing I already use" — Google, GitHub, Microsoft, etc. Maintaining a
   bespoke local password store with email verification, MFA, password
   reset, and lockout policies is non-trivial and is not the product.
2. Organization owners on paid plans who must integrate with their own
   identity provider (Okta, Entra ID, Keycloak, in-house Authentik) and
   want their employees provisioned automatically without us holding any
   user passwords.

Both audiences are well-served by OIDC. The remaining decision is who runs
the default identity provider for case (1) and how case (2) plugs in.

Three options were considered:

1. **Roll our own auth server** (Lucia / better-auth / hand-rolled) —
   maximum control, but we then own MFA, password resets, audit, account
   recovery, abuse prevention, and the social-login long tail forever.
   This is the part of an auth product that is least differentiating and
   most dangerous.
2. **A hosted SaaS auth provider** (Auth0, Clerk, WorkOS) — one less
   container, but per-MAU pricing punishes a free tier with high signup
   volume and modest revenue per user, and adds a hard upstream
   dependency we cannot self-host for the eventual on-prem distribution.
3. **Run Authentik ourselves as the default provider, and accept any
   OIDC-compliant provider per subscription** — Authentik is open source,
   self-hostable, supports all the common social providers as upstream
   sources, has a clean OIDC interface, and is one of the few options that
   stays usable in the on-prem packaging we want for enterprise.

## Decision

**Tolaria runs an Authentik instance as the default identity provider.
Subscription owners may register additional OIDC providers via the SSO
admin UI; users in that subscription then sign in through their own IdP
instead of Authentik.**

Specifics:

1. The platform-default Authentik provider is stored as a row in
   `sso_providers` with `subscription_id IS NULL`. RLS allows any session to
   read this row (it is the public login fallback).
2. Subscription owners can `POST /admin/sso/providers` with their own
   issuer URL, client id, encrypted client secret, scopes, default role for
   new members, and a JIT-provisioning toggle. The row is scoped to their
   subscription via RLS.
3. Sign-in flow uses Authorization Code with PKCE only. We do not implement
   implicit or hybrid flows. Tokens are exchanged server-side; the browser
   never sees the upstream client secret.
4. After successful upstream auth, the API mints its own short-lived JWT
   (10 min access) and a long-lived refresh token (httpOnly, Secure,
   SameSite=Lax, 30 days). The browser SPA stores the access token in
   memory only; the refresh cookie is the only durable secret.
5. JIT provisioning: when a user signs in via a subscription-scoped
   provider for the first time, a `users` row is created with
   `subscription_id` set and `role` defaulted from the provider config. If
   JIT is disabled, the login fails with a clear "ask your admin to invite
   you" error.
6. Account linking: a user authenticated via Authentik may attach an
   additional provider's identity to the same `users` row, so an org
   migration from Google to their corporate Entra ID does not duplicate
   accounts. The link is keyed on verified email plus a confirmation step.
7. Local password auth is retained behind a `LOCAL_PASSWORD_AUTH=1` env
   flag for desktop development and self-hosted single-tenant deploys. It
   is off in production.
8. Provider client secrets are stored encrypted at rest using a key from
   `AUTH_PROVIDER_SECRET_KEY` (32 bytes). Decryption happens only inside the
   API process when initiating an OIDC flow.

## Alternatives considered

- **Roll our own** (rejected): too much undifferentiated surface, too
  dangerous to get wrong.
- **Hosted SaaS provider** (rejected): per-MAU pricing is hostile to a
  free tier; cannot ship on-prem.
- **SAML in v1** (deferred): some enterprises want it; we will add it as a
  second adapter once OIDC is shipped. The data model already accommodates
  it (`sso_providers.protocol` is `'oidc'` today, room for `'saml'` later).
- **Allow per-user IdP selection on the public login page** (rejected for
  v1): leaks the list of subscriptions' identity providers; instead, users
  hit the platform default and the API redirects them to the correct
  provider once their subscription is known.

## Consequences

- One self-hostable container (Authentik) is part of every deployment,
  including local dev (`docker-compose.yml` brings it up on port 9000).
- The `sso_providers` table and admin routes are first-class — see
  `docs/ARCHITECTURE-WEB-SAAS.md` §5 for the API surface.
- Adding SAML later means a new adapter behind the same `/auth/sso/:id`
  routes; no schema migration beyond a `protocol` column.
- The desktop client's existing per-provider AI key UI is unchanged; this
  ADR concerns user authentication, not model authentication.
- Any future move to a hosted provider becomes a metadata edit on the
  default `sso_providers` row plus a config flip, with no code changes in
  the request path.
