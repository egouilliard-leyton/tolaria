import { z } from 'zod'
import { withTenant } from '../lib/db.js'
import { slugify } from '../lib/slug.js'

// Job payload — every job carries the tenant id so the handler can wrap its
// DB work in withTenant() and stay inside RLS. See ADR-0115.
export const IndexNotePayload = z.object({
  subscriptionId: z.string().uuid(),
  vaultId: z.string().uuid(),
  noteId: z.string().uuid(),
})
export type IndexNotePayload = z.infer<typeof IndexNotePayload>

// `[[wikilink]]` and `[[wikilink|alias]]`. Capture group 1 is the raw target
// text; capture group 2 (the alias including the leading `|`) is unused but
// kept so the regex matches the same shape the rename SQL uses.
const WIKILINK_RE = /\[\[([^\]|]+)(\|[^\]]*)?\]\]/g

interface NoteRow {
  id: string
  vault_id: string
  title: string
  body_md: string | null
}

/**
 * Recompute the search and link-graph derived state for a single note.
 *
 * Idempotent: callers may re-deliver the same payload after a crash and the
 * row state will converge to the same final value. Soft-deleted notes are
 * a no-op so that a `DELETE` followed by a stale index job does not
 * resurrect derived rows pointing at the deleted note (the foreign-key
 * cascades on `notes.deleted_at` are handled separately).
 */
export async function handleIndexNote(payload: IndexNotePayload): Promise<void> {
  const ctx = { subscriptionId: payload.subscriptionId }
  await withTenant(ctx, async (client) => {
    const { rows } = await client.query<NoteRow>(
      `SELECT id, vault_id, title, body_md
         FROM notes
        WHERE id = $1 AND deleted_at IS NULL`,
      [payload.noteId],
    )
    const note = rows[0]
    if (!note) {
      // Deleted or never existed — handler is a no-op so reruns are safe.
      return
    }

    // 1. Upsert the search row. We compute the tsvector inside Postgres so
    // the configuration ('simple') matches whatever the query side uses.
    // TODO(embedding): compute and persist the pgvector embedding here once
    // the embedding model + budgeting story is finalised. Leaving NULL for
    // now keeps full-text search working without blocking on the AI side.
    const docText = `${note.title} ${note.body_md ?? ''}`
    await client.query(
      `INSERT INTO note_search (note_id, vault_id, ts_doc)
       VALUES ($1, $2, to_tsvector('simple', $3))
       ON CONFLICT (note_id) DO UPDATE
         SET ts_doc   = EXCLUDED.ts_doc,
             vault_id = EXCLUDED.vault_id`,
      [note.id, note.vault_id, docText],
    )

    // 2. Rebuild the link graph for this note. Wipe-then-insert keeps the
    // logic simple; we don't need to compute a diff because the row count
    // per source is small and the table has a (src, dst_text, kind)
    // primary key that would otherwise force us to dedupe on the way in.
    await client.query(
      `DELETE FROM note_links WHERE src_note_id = $1`,
      [note.id],
    )

    const links = parseWikilinks(note.body_md ?? '')
    if (links.length === 0) return

    // Resolve each unique destination text to a slug → note id. We dedupe
    // by `dst_text` (the raw match) to honour the table's primary key.
    const seen = new Set<string>()
    for (const dstText of links) {
      if (seen.has(dstText)) continue
      seen.add(dstText)

      const dstSlug = slugify(dstText)
      const resolved = await client.query<{ id: string }>(
        `SELECT id FROM notes
          WHERE vault_id = $1 AND slug = $2 AND deleted_at IS NULL`,
        [note.vault_id, dstSlug],
      )
      const dstNoteId = resolved.rows[0]?.id ?? null

      await client.query(
        `INSERT INTO note_links (src_note_id, dst_note_id, dst_text, kind)
         VALUES ($1, $2, $3, 'wikilink')
         ON CONFLICT (src_note_id, dst_text, kind) DO UPDATE
           SET dst_note_id = EXCLUDED.dst_note_id`,
        [note.id, dstNoteId, dstText],
      )
    }
  })
}

/**
 * Pull the raw target text from every `[[wikilink]]` (or aliased form) in a
 * markdown body. Order is preserved so callers can reason about
 * first-occurrence behaviour, but de-duplication is left to the caller —
 * `note_links`'s primary key already constrains uniqueness.
 *
 * Exported for unit tests.
 */
export function parseWikilinks(bodyMd: string): string[] {
  const out: string[] = []
  // Reset lastIndex on a *cloned* regex so concurrent callers don't fight.
  const re = new RegExp(WIKILINK_RE.source, WIKILINK_RE.flags)
  for (const match of bodyMd.matchAll(re)) {
    const target = match[1]?.trim()
    if (target) out.push(target)
  }
  return out
}
