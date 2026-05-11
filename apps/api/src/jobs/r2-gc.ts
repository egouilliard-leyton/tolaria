// Producer for the `r2-gc` job and the `cleanupUnverifiedJob` describer
// for the worker. See ADR-0116 §7.
//
// cleanupUnverifiedJob (NOT implemented here — orchestrator scope):
//   The worker should run on a 5-minute interval and execute, per row:
//
//     DELETE FROM attachments
//      WHERE verified_at IS NULL
//        AND created_at < now() - interval '1 hour';
//
//   For each deleted row it should also enqueue an `r2-gc` job so any object
//   that did make it to R2 (despite the verify step never landing) is also
//   cleaned up. The 1-hour grace period is intentional — a slow uploader on
//   a flaky connection must not have its attachment deleted from under it.
//
// The job handler (also worker scope) consumes `r2-gc` payloads, calls
// services/r2.ts deleteObject(), then removes the attachments row inside a
// withTenant() transaction. Order matters: object first, then row, so that
// a failure between the two leaves the row pointing at the (already-gone)
// key, which is harmless because the cleanup pass is idempotent.

import { enqueue, type JobPayloads } from './index.js'

export type R2GcPayload = JobPayloads['r2-gc']

/**
 * Schedule deletion of an attachment's R2 object and metadata row.
 * Called by the API on DELETE /attachments/:id.
 */
export async function scheduleR2Gc(payload: R2GcPayload): Promise<string | null> {
  return enqueue('r2-gc', payload, {
    // Modest retry — failures are typically transient R2 5xx responses.
    retryLimit: 5,
    // Use the attachment id as the singleton key so a double-DELETE doesn't
    // queue two delete jobs for the same object.
    singletonKey: payload.attachmentId,
  })
}
