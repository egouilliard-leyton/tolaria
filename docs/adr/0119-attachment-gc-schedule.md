---
type: ADR
id: "0119"
title: "Attachment GC schedule (supplement to ADR-0116)"
status: active
date: 2026-05-11
---

## Context

ADR-0116 §4 specifies that unverified `attachments` rows are
GC'd after a one-hour grace period, but does not say *how* the
collector runs. The verification round flagged that the cadence had
been left undocumented (audit-2026-05-10 gap G23 / G66), even though
the worker already schedules a periodic sweep. This ADR records the
schedule decision so future ops work has a single place to look.

**This is a small supplement to ADR-0116, not a supersession.**
ADR-0116 remains the authoritative document for the R2 storage model;
this ADR fills in the sweep cadence detail.

## Decision

**The `r2-gc` worker schedules an `unverified-sweep` job every 10
minutes via pg-boss, with a singleton key so a slow sweep is never
dispatched twice concurrently. The grace interval is tunable via the
`R2_UNVERIFIED_GRACE_INTERVAL` env (default `'1 hour'`).**

Specifics:

1. `apps/worker/src/index.ts` calls:
   ```ts
   boss.schedule(
     'r2-gc',
     '*/10 * * * *',
     { mode: 'unverified-sweep' },
     { singletonKey: 'unverified-sweep' },
   )
   ```
2. The handler in `apps/worker/src/handlers/r2-gc.ts` reads the grace
   interval from `R2_UNVERIFIED_GRACE_INTERVAL`. The default keeps
   ADR-0116 §4's "1 hour" wording intact; operators can tighten or
   loosen it without a code change.
3. The handler enumerates the tenants that currently have stale
   unverified rows and then runs the sweep once per tenant under the
   appropriate `withTenant` scope. RLS stays honest — the
   platform-context escape hatch is not used here.
4. Cadence rationale: 10 minutes is short enough that an interrupted
   PUT does not linger in the metadata table for longer than the
   grace window itself (1 hour grace + ≤ 10 min sweep latency =
   ≤ 70 min from upload-attempt to row deletion), and long enough
   that the sweep cost is negligible across the platform.

## Consequences

- The schedule lives in code, not in ops runbooks; redeploying the
  worker is the only way to change the cron expression. Operators
  who need a faster cadence in production should add the cron to a
  follow-up config rather than editing this ADR.
- `R2_UNVERIFIED_GRACE_INTERVAL` is the only knob exposed to ops.
  When tuning, prefer this over the cron expression.
- Singleton key `unverified-sweep` prevents a slow sweep from being
  dispatched twice concurrently — important because the handler
  iterates tenants serially and a backed-up cluster could otherwise
  pile up duplicates.
- ADR-0116 stays the canonical reference for the R2 storage model;
  link to *this* ADR from any ops doc that mentions the GC.
