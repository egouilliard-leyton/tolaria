// POST /vaults/:vaultId/rename
//
// One transaction, two writes:
//   1. Rename the target note (slug + title).
//   2. Rewrite [[fromPath]] and [[fromPath|alias]] occurrences in every other
//      note's body_md inside the same vault.
//
// We use a single SQL UPDATE with regexp_replace so the database — not Node —
// does the rewrite, which means the rename either applies wholesale or rolls
// back together on error.
//
// The wikilink grammar we recognise is intentionally narrow:
//   [[<path>]]                       — bare link
//   [[<path>|<alias>]]               — aliased link
// We do NOT touch:
//   [[<path>#heading]]               — would need careful handling of the
//                                      anchor; v2 will extend the SQL
//   [[<otherPath that contains fromPath as a substring>]]
//                                      — guarded by a literal anchor in the
//                                      regex (see `pathLiteral` below).

import { Hono } from 'hono'
import type { PgClient } from '../db.js'
import { withTenant } from '../db.js'
import { enqueue } from '../jobs/index.js'
import { writeAudit } from '../lib/audit.js'
import { Conflict, NotFound } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { RenameBody, VaultIdRouteParam } from '../lib/schemas.js'
import { slugify } from '../lib/slug.js'
import { readJson, readParams } from '../lib/validate.js'
import { assertVaultExists } from './vaults.js'

// Internal result shape — kept camelCase so the SQL implementation reads
// naturally. The route handler translates to snake_case at the wire boundary
// before responding (see RenameResultDto in the SPA's http-adapter.ts).
interface RenameResult {
  affectedNoteIds: string[]
  updatedLinkCount: number
}

export const rename = new Hono()

rename.post('/vaults/:vaultId/rename', async (c) => {
  const { vaultId } = readParams(c, VaultIdRouteParam)
  const body = await readJson(c, RenameBody)
  const tenant = c.get('tenant')
  const user = c.get('user')

  const result = await withTenant(tenant, async (client) => {
    await assertVaultExists(client, vaultId)
    const renamed = await runRename(client, vaultId, body.from_path, body.to_path)
    // ADR-0115 §Consequences: rename.run is audited inside the same
    // transaction as the slug + body rewrites so the audit row commits or
    // rolls back atomically with the rename.
    await writeAudit(client, tenant, 'rename.run', vaultId, {
      vault_id: vaultId,
      from_path: body.from_path,
      to_path: body.to_path,
      affected_note_ids: renamed.affectedNoteIds,
      updated_link_count: renamed.updatedLinkCount,
    })
    return renamed
  })

  // Best-effort: enqueue a propagation job so the worker can rebuild
  // note_links and ts_doc. The transaction has already committed, so a queue
  // failure is logged but not surfaced to the client.
  await enqueue('propagate-rename', {
    subscriptionId: user.sid,
    vaultId,
    fromPath: body.from_path,
    toPath: body.to_path,
    affectedNoteIds: result.affectedNoteIds,
  }).catch((err) => logger.error({ err }, 'propagate-rename enqueue failed'))

  // Translate to the snake_case wire shape the SPA expects.
  return c.json({
    affected_note_ids: result.affectedNoteIds,
    updated_link_count: result.updatedLinkCount,
  })
})

async function runRename(
  client: PgClient,
  vaultId: string,
  fromPath: string,
  toPath: string,
): Promise<RenameResult> {
  // The target note is identified by `slug = fromPath` — wikilinks resolve
  // against slugs in this codebase. (See note about subfolder paths below.)
  // If the caller passed a "folder/note" style path we treat the segment
  // after the last '/' as the slug; folders are not part of the slug today,
  // and the worker that maintains note_links is the source of truth for
  // dst-text resolution.
  const fromSlug = fromPath.includes('/')
    ? fromPath.slice(fromPath.lastIndexOf('/') + 1)
    : fromPath
  const toSlug = toPath.includes('/')
    ? toPath.slice(toPath.lastIndexOf('/') + 1)
    : toPath

  const targetRes = await client.query<{ id: string }>(
    `SELECT id FROM notes
      WHERE vault_id = $1 AND slug = $2 AND deleted_at IS NULL
      FOR UPDATE`,
    [vaultId, fromSlug],
  )
  const targetRow = targetRes.rows[0]
  if (!targetRow) throw NotFound('note not found at fromPath')
  const targetId = targetRow.id

  // Slug collisions on the destination need to be a 409 so the UI can show
  // a confirm/replace dialog. We do this check before the link rewrite.
  if (toSlug !== fromSlug) {
    const collide = await client.query(
      `SELECT 1 FROM notes
        WHERE vault_id = $1 AND slug = $2 AND deleted_at IS NULL`,
      [vaultId, toSlug],
    )
    if (collide.rowCount !== null && collide.rowCount > 0) {
      throw Conflict('a note with this slug already exists', { code: 'slug_taken' })
    }
  }

  // Update the target note's slug + title. The title is derived from the
  // toPath (last segment, un-slugified) when the caller provided a clean
  // path; otherwise we just keep the existing title.
  const newTitle = humanise(toSlug)
  await client.query(
    `UPDATE notes
        SET slug = $2,
            title = $3,
            modified_at = now(),
            version = version + 1
      WHERE id = $1`,
    [targetId, toSlug, newTitle],
  )

  // Rewrite wikilinks in every other note. We match two distinct forms in
  // a single regex via a top-level alternation:
  //
  //   \[\[<from>(\|[^\]]*)?\]\]
  //
  // The optional capturing group preserves the alias if present, and is
  // re-inserted in the replacement using `\1`. The pattern is anchored on
  // `\[\[` … `\]\]` so we never eat substrings of longer paths.
  //
  // To know how many links were rewritten we count occurrences via
  // regexp_matches('g'), which returns one row per match. We do that in a
  // separate CTE projection rather than relying on the Postgres-15-only
  // regexp_count function.

  const pathLiteral = escapeRegex(fromPath)
  const pattern = `\\[\\[${pathLiteral}(\\|[^\\]]*)?\\]\\]`
  const replacement = `[[${toPath.replace(/\\/g, '\\\\').replace(/&/g, '\\&')}\\1]]`

  const updateRes = await client.query<{
    id: string
    rewritten: string | number
  }>(
    `WITH targets AS (
       SELECT id, body_md
         FROM notes
        WHERE vault_id = $1
          AND id <> $2
          AND deleted_at IS NULL
          AND body_md ~ $3
     ),
     match_counts AS (
       SELECT t.id, count(*)::bigint AS rewritten
         FROM targets t,
              LATERAL regexp_matches(t.body_md, $3, 'g') AS m
        GROUP BY t.id
     ),
     rewritten AS (
       SELECT t.id,
              regexp_replace(t.body_md, $3, $4, 'g') AS new_body
         FROM targets t
     )
     UPDATE notes n
        SET body_md = r.new_body,
            modified_at = now(),
            version = n.version + 1
       FROM rewritten r
       JOIN match_counts mc ON mc.id = r.id
      WHERE n.id = r.id
      RETURNING n.id, mc.rewritten`,
    [vaultId, targetId, pattern, replacement],
  )

  const affectedNoteIds = [targetId, ...updateRes.rows.map((r) => r.id)]
  const updatedLinkCount = updateRes.rows.reduce(
    (sum, r) => sum + Number(r.rewritten ?? 0),
    0,
  )
  return { affectedNoteIds, updatedLinkCount }
}

// `[[wiki|alias]]` is more useful when the target slug remains the slug, but
// users will sometimes supply a Title-cased toPath. We never assume; just
// derive a readable title from the slug. The slugify helper guarantees the
// reverse direction is well-defined.
function humanise(slug: string): string {
  // If the caller gave us something that isn't pure kebab-case, try to keep
  // their casing. Otherwise turn 'my-cool-note' into 'My Cool Note'.
  if (slug !== slugify(slug)) return slug
  return slug
    .split('-')
    .filter((w) => w.length > 0)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
}

function escapeRegex(s: string): string {
  // POSIX ERE: escape every metacharacter we care about.
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
