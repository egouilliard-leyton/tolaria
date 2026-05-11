---
type: ADR
id: "0121"
title: "CSP style-src 'unsafe-inline' (supplement to plan §9)"
status: active
date: 2026-05-11
---

## Context

`docs/ARCHITECTURE-WEB-SAAS.md` §9 lays out the Content-Security-Policy
the API attaches to every response. The plan's wording calls for a CSP
that is "as tight as the SPA can tolerate", and the verification round
(audit-2026-05-10 G62) flagged that the live header still includes
`style-src 'self' 'unsafe-inline'` rather than the strictly self-only
form the plan implies.

The reason `unsafe-inline` is present in the live header is mechanical,
not architectural: the SPA uses shadcn/ui, which depends on
`class-variance-authority` (cva) and a handful of Radix primitives that
inject inline `<style>` blocks at runtime — for theme variables,
animation keyframes, and per-component positional math (Radix popper
transforms, dialog overlays, etc.). Removing `unsafe-inline` without
also adopting a CSP nonce flow would visually break large portions of
the app.

The audit identified two remediation paths:

- **(a)** Adopt a nonce-based CSP. The middleware generates a per-request
  random nonce, exposes it via `c.set(...)` so the SSR/index template
  can stamp `<style nonce="…">` on the initial document, and the CSP
  becomes `style-src 'self' 'nonce-<value>'`. This requires (i) wiring
  the nonce through the index.html template, (ii) teaching cva and the
  affected Radix primitives to read the nonce, (iii) auditing every
  third-party component for inline-style emitters that don't honour a
  nonce, and (iv) shipping a regression test that catches CSP violation
  reports. None of this is impossible, but it is squarely outside the
  scope of the v1 SaaS plan.
- **(b)** Keep `'unsafe-inline'` for `style-src` only (inline `<script>`
  remains banned) and document the deviation explicitly. Inline styles
  are far less dangerous than inline scripts: a successful inline-style
  injection cannot exfiltrate data on its own and cannot execute
  arbitrary code. Combined with `script-src 'self'`, `frame-ancestors
  'none'`, and `X-Content-Type-Options: nosniff`, the residual risk is
  primarily UI-redress (overlay injection) rather than data
  exfiltration.

For v1 we pick **(b)**. The plan's §9 wording remains the target end
state; this ADR records the deliberate, time-bounded deviation.

**This is a small supplement to plan §9 (the CSP section) and ADRs
0115-0120, not a supersession.** The RLS, R2, OIDC, and platform-context
contracts those ADRs encode all stand as written; this ADR only widens
the style-src directive while keeping inline scripts banned.

## Decision

**The CSP emitted by `apps/api/src/middleware/security-headers.ts`
keeps `style-src 'self' 'unsafe-inline'` for v1. Inline scripts remain
banned (`script-src 'self'`). A nonce-based style-src is the v2 target
and is tracked as a follow-up; until then the deviation is documented
here.**

Specifics:

1. The header value in `security-headers.ts` is:
   ```
   default-src 'self';
   img-src 'self' <r2-origin> data:;
   connect-src 'self' <r2-origin> <litellm-origin>;
   script-src 'self';
   style-src 'self' 'unsafe-inline';
   frame-ancestors 'none';
   base-uri 'self';
   form-action 'self'
   ```
2. A comment in `security-headers.ts` next to the `style-src` line
   points at this ADR so future readers don't have to grep the audit.
3. The v2 plan: introduce a per-request nonce via a Hono middleware
   that runs *before* `securityHeaders`, stamp it on the index template
   and on cva's style-emitter, then drop `'unsafe-inline'`. This work
   should land alongside the next major shadcn/ui upgrade so the
   third-party audit is amortised over a single PR.

## Consequences

- The CSP is weaker than the plan §9 long-term wording, but only on
  `style-src`. Inline scripts, `unsafe-eval`, mixed content, and
  cross-origin frame embedding all remain blocked.
- Anyone reading plan §9 + this ADR understands exactly what the live
  CSP looks like and why. The deviation has a clear remediation path.
- A nonce-based CSP is a v2 deliverable and should not be conflated
  with v1 GA criteria.
- This ADR is a supplement: it does NOT supersede ADRs 0115-0120 or
  the plan's other security contracts. Re-tightening the CSP is a
  future change that will land its own ADR.
