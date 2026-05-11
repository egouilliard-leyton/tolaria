import pino from 'pino'
import { z } from 'zod'
import { loadEnv } from '../env.js'
import { withTenant } from '../lib/db.js'
import { slugify } from '../lib/slug.js'
import {
  checkAndIncrementBudget,
  embedText,
  estimateCents,
} from '../services/embeddings.js'

const logger = pino({ level: loadEnv().LOG_LEVEL, base: { app: 'tolaria-worker', mod: 'index-note' } })

// Cap the embedding input length so we don't blow past the model's
// context window (and over-bill ourselves) on huge notes. 8k characters
// is roughly 2k tokens — comfortably inside every common embedding
// model's input limit.
const EMBED_INPUT_MAX_CHARS = 8000

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
      // Soft-deleted or never existed. Clean up the derived rows so a
      // stale `note_search` entry cannot keep returning hits and a
      // soft-deleted note's outgoing wikilinks cannot keep pointing at
      // it. The cascade on `notes.deleted_at` does not run for soft
      // deletes — only the hard-DELETE retention worker triggers the
      // FK cascade. See audit-2026-05-10 Bundle L (G67).
      await client.query(
        `DELETE FROM note_search WHERE note_id = $1`,
        [payload.noteId],
      )
      await client.query(
        `DELETE FROM note_links WHERE src_note_id = $1`,
        [payload.noteId],
      )
      return
    }

    // 1. Upsert the search row. We compute the tsvector inside Postgres so
    // the configuration ('simple') matches whatever the query side uses.
    const docText = `${note.title} ${note.body_md ?? ''}`
    await client.query(
      `INSERT INTO note_search (note_id, vault_id, ts_doc)
       VALUES ($1, $2, to_tsvector('simple', $3))
       ON CONFLICT (note_id) DO UPDATE
         SET ts_doc   = EXCLUDED.ts_doc,
             vault_id = EXCLUDED.vault_id`,
      [note.id, note.vault_id, docText],
    )

    // 1b. Optional embedding write. Only runs when an embedding model is
    // configured AND the tenant has daily budget left. Any failure here
    // (timeout, upstream 5xx, budget exhausted) is swallowed — the
    // full-text path above is the source of truth for search and the
    // embedding column is additive. See Bundle F.
    const env = loadEnv()
    if (env.LITELLM_EMBEDDING_MODEL) {
      try {
        const embedInput =
          `${note.title}\n\n${note.body_md ?? ''}`.slice(0, EMBED_INPUT_MAX_CHARS)
        const cents = estimateCents(embedInput)
        const withinBudget = await checkAndIncrementBudget(
          client,
          payload.subscriptionId,
          cents,
        )
        if (!withinBudget) {
          logger.info(
            { subscriptionId: payload.subscriptionId, noteId: note.id, cents },
            'embedding skipped: daily budget exhausted',
          )
        } else {
          const embedding = await embedText(embedInput, env.LITELLM_EMBEDDING_MODEL, {
            // Per-tenant cost attribution. Mirrors the chat/agent route
            // shape in `apps/api/src/services/litellm.ts`. We do not know
            // the originating user id from a worker job (the index queue
            // is producer-agnostic) so the `user:` tag is intentionally
            // omitted. See audit-2026-05-10 Bundle K (G48).
            metadataTags: [
              `subscription:${payload.subscriptionId}`,
              `vault:${payload.vaultId}`,
              `kind:embedding`,
            ],
          })
          if (embedding.length !== env.EMBEDDING_DIMS) {
            logger.warn(
              {
                noteId: note.id,
                expected: env.EMBEDDING_DIMS,
                received: embedding.length,
              },
              'embedding length mismatch; skipping write',
            )
          } else {
            await client.query(
              `UPDATE note_search SET embedding = $1::vector WHERE note_id = $2`,
              [`[${embedding.join(',')}]`, note.id],
            )
          }
        }
      } catch (err) {
        logger.warn(
          { err, noteId: note.id },
          'embedding write failed; full-text path is unaffected',
        )
      }
    }

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
