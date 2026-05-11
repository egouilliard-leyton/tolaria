import type { Job } from 'pg-boss'
import { z } from 'zod'
import { withTenant } from '../lib/db.js'
import { enqueueIndexNote } from '../lib/jobs.js'

// The producer in `apps/api/src/routes/rename.ts` sends every payload that
// matches this schema. We accept both the old shape (just from/to paths)
// and the new shape (which includes the explicit list of affected note
// ids) so a queue with in-flight v1 messages does not break on rollout.
const PropagateRenamePayload = z.object({
  subscriptionId: z.string().uuid(),
  vaultId: z.string().uuid(),
  fromPath: z.string(),
  toPath: z.string(),
  fromSlug: z.string().optional(),
  toSlug: z.string().optional(),
  affectedNoteIds: z.array(z.string().uuid()).optional(),
})
export type PropagateRenamePayload = z.infer<typeof PropagateRenamePayload>

/**
 * After the rename SQL has rewritten every `[[from]]` body in the vault,
 * `note_links` and `note_search.ts_doc` for those touched notes are stale.
 * The cheapest fix is to re-fan the affected ids through `index-note`,
 * which already knows how to rebuild both derived tables idempotently.
 *
 * If the producer did not provide `affectedNoteIds` (older shape), we
 * resolve the candidate set ourselves: every non-deleted note in the
 * vault whose body still contains `[[fromPath]]` or `[[toPath]]`. That
 * is over-broad on purpose — re-indexing is cheap and idempotent.
 */
export async function handlePropagateRename(job: Job<unknown>): Promise<void> {
  const payload = PropagateRenamePayload.parse(job.data)

  const noteIds = payload.affectedNoteIds ?? (await resolveAffectedIds(payload))

  for (const id of noteIds) {
    await enqueueIndexNote({
      subscriptionId: payload.subscriptionId,
      vaultId: payload.vaultId,
      noteId: id,
    })
  }
}

async function resolveAffectedIds(
  payload: PropagateRenamePayload,
): Promise<string[]> {
  const ctx = { subscriptionId: payload.subscriptionId }
  return withTenant(ctx, async (client) => {
    // Match either the old or new wikilink target so we cover the bodies
    // the producer's SQL has already rewritten plus any straggler that
    // still references the old slug (e.g. failed prior pass).
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM notes
        WHERE vault_id = $1
          AND deleted_at IS NULL
          AND (body_md ~ $2 OR body_md ~ $3)`,
      [payload.vaultId, anchored(payload.fromPath), anchored(payload.toPath)],
    )
    return rows.map((r) => r.id)
  })
}

function anchored(slugOrPath: string): string {
  // Anchor the regex against `[[...]]` so we don't false-match plain prose
  // that happens to contain the slug as a substring. We anchor on the
  // *slug* (last segment after any folder prefix in slugOrPath) and
  // optionally accept a folder prefix in the wikilink body, mirroring
  // the route's regex in `apps/api/src/routes/rename.ts`. POSIX ERE
  // escaping (no `\b`, so the folder prefix uses a literal `/`).
  //
  // See audit-2026-05-10 Bundle L (G68).
  const slug = slugOrPath.includes('/')
    ? slugOrPath.slice(slugOrPath.lastIndexOf('/') + 1)
    : slugOrPath
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `\\[\\[([^\\]|]*/)?${escaped}(\\|[^\\]]*)?\\]\\]`
}
