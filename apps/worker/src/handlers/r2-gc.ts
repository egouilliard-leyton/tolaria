import type { Job } from 'pg-boss'

// Stub handler for the `r2-gc` queue. Producers in
// apps/api/src/jobs/r2-gc.ts enqueue a delayed job after an attachment is
// soft-deleted so the bytes can be reaped from R2 once the grace window is up.
// The real implementation will headObject + deleteObject via services/r2.ts
// and then hard-delete the row. Until then we accept and complete the job so
// the queue does not back up.
export async function handleR2Gc(job: Job<unknown>): Promise<void> {
  // TODO(agent attachments): delete orphaned R2 object + hard-delete row.
  void job
}
