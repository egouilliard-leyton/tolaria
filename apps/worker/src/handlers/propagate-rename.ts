import type { Job } from 'pg-boss'

// Stub handler for the `propagate-rename` queue. Producers in
// apps/api/src/routes/rename.ts enqueue one job per rename so the worker can
// rebuild the affected wikilinks + tsvectors out-of-band. The real implementation
// will:
//   1. Resolve every note that links to the renamed slug under the job's
//      tenant context (withTenant from @tolaria/api).
//   2. Rewrite `[[old]]` references to `[[new]]` inside body_md atomically.
//   3. Rebuild note_links for the touched notes and re-enqueue index-note jobs.
// Until then we accept and complete the job so the queue does not back up.
export async function handlePropagateRename(job: Job<unknown>): Promise<void> {
  // TODO(agent search/rename): rebuild note_links + ts_doc for affected notes.
  void job
}
