// Attachment routes — see ADR-0116 and ARCHITECTURE-WEB-SAAS.md §5.
//
// Lifecycle:
//   1. POST /vaults/:vaultId/attachments  → row inserted (verified_at = NULL),
//      presigned PUT URL returned. Browser uploads directly to R2.
//   2. POST /attachments/:id/verify       → API headObject's the bucket,
//      compares Content-Length and x-amz-meta-sha256, then sets verified_at.
//   3. GET  /attachments/:id              → 302 to a fresh presigned GET URL,
//      but only after verification.
//   4. DELETE /attachments/:id            → soft-mark + enqueue r2-gc job.
//
// The API never reads upload bytes. The browser never sees R2 credentials.
// Every mutation runs inside withTenant() so RLS scopes the row.

import { Hono } from 'hono'
import { withTenant } from '../db.js'
import {
  ATTACHMENT_MAX_SIZE_BYTES,
  AttachmentIdParam,
  CreateAttachmentBody,
  VaultIdRouteParam,
  isAllowedAttachmentMime,
} from '../lib/schemas.js'
import { Conflict, InvalidInput, NotFound } from '../lib/errors.js'
import { scheduleR2Gc } from '../jobs/r2-gc.js'
import { buildKey, headObject, presignGet, presignPut } from '../services/r2.js'
import type { Attachment } from './attachments-types.js'

export const attachments = new Hono()

interface AttachmentRow {
  id: string
  vault_id: string
  note_id: string | null
  key_r2: string
  mime: string
  size_bytes: string | number
  sha256: string
  verified_at: Date | null
  created_at: Date
}

// ── POST /vaults/:vaultId/attachments ─────────────────────────────────────

attachments.post('/vaults/:vaultId/attachments', async (c) => {
  const params = VaultIdRouteParam.parse(c.req.param())
  const body = CreateAttachmentBody.parse(await c.req.json().catch(() => ({})))

  if (!isAllowedAttachmentMime(body.mime)) {
    throw InvalidInput(`mime type not allowed: ${body.mime}`, {
      allowed: ['image/*', 'audio/*', 'video/*', 'application/pdf', 'text/plain'],
    })
  }
  if (body.size > ATTACHMENT_MAX_SIZE_BYTES) {
    // TODO: per-plan cap once billing lands; for now MVP hardcodes 50 MB.
    throw InvalidInput(`size exceeds plan cap (${ATTACHMENT_MAX_SIZE_BYTES} bytes)`, {
      maxBytes: ATTACHMENT_MAX_SIZE_BYTES,
    })
  }

  const tenant = c.get('tenant')

  // Insert row first so we have a stable attachmentId to use in the R2 key.
  // RLS will refuse the insert if the vault belongs to another tenant.
  const inserted = await withTenant(tenant, async (client) => {
    // Verify the vault exists for this tenant; if RLS hides it the SELECT
    // returns zero rows and we return 404 rather than a confusing FK error.
    const vault = await client.query<{ id: string }>(
      'SELECT id FROM vaults WHERE id = $1 AND deleted_at IS NULL',
      [params.vaultId],
    )
    if (vault.rowCount === 0) throw NotFound('vault not found')

    if (body.noteId) {
      const note = await client.query<{ id: string }>(
        'SELECT id FROM notes WHERE id = $1 AND vault_id = $2 AND deleted_at IS NULL',
        [body.noteId, params.vaultId],
      )
      if (note.rowCount === 0) throw NotFound('note not found')
    }

    const result = await client.query<AttachmentRow>(
      `INSERT INTO attachments (vault_id, note_id, key_r2, mime, size_bytes, sha256, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, vault_id, note_id, key_r2, mime, size_bytes, sha256, verified_at, created_at`,
      [
        params.vaultId,
        body.noteId ?? null,
        // Placeholder; we update with the real key once we have the row id.
        '__pending__',
        body.mime,
        body.size,
        body.sha256,
        tenant.userId,
      ],
    )
    const row = result.rows[0]
    if (!row) throw new Error('insert returned no row')

    const key = buildKey({
      subscriptionId: tenant.subscriptionId,
      vaultId: row.vault_id,
      attachmentId: row.id,
      filename: body.filename,
    })

    await client.query('UPDATE attachments SET key_r2 = $1 WHERE id = $2', [key, row.id])
    row.key_r2 = key
    return row
  })

  const presigned = await presignPut(inserted.key_r2, body.mime, body.size, body.sha256)

  return c.json({
    id: inserted.id,
    putUrl: presigned.url,
    key: inserted.key_r2,
    headers: presigned.headers,
    expiresIn: presigned.expiresIn,
  })
})

// ── POST /attachments/:id/verify ──────────────────────────────────────────

attachments.post('/attachments/:id/verify', async (c) => {
  const params = AttachmentIdParam.parse(c.req.param())
  const tenant = c.get('tenant')

  const row = await withTenant(tenant, async (client) => {
    const r = await client.query<AttachmentRow>(
      `SELECT id, vault_id, note_id, key_r2, mime, size_bytes, sha256, verified_at, created_at
         FROM attachments
        WHERE id = $1`,
      [params.id],
    )
    return r.rows[0] ?? null
  })
  if (!row) throw NotFound('attachment not found')

  // Compare what the row claimed at create-time against what landed in R2.
  // headObject throws NotFound on 404 — leak the message as a Conflict so the
  // client knows to re-upload rather than mistake it for a missing row.
  let head
  try {
    head = await headObject(row.key_r2)
  } catch (err) {
    // NotFound from R2 means the upload never landed (or was already GC'd).
    if (err && typeof err === 'object' && 'code' in err && err.code === 'not_found') {
      throw Conflict('verification_failed', { reason: 'object_missing' })
    }
    throw err
  }

  const declaredSize = Number(row.size_bytes)
  if (head.contentLength !== declaredSize) {
    throw Conflict('verification_failed', {
      reason: 'size_mismatch',
      declared: declaredSize,
      actual: head.contentLength,
    })
  }
  if (!head.sha256 || head.sha256.toLowerCase() !== row.sha256.toLowerCase()) {
    throw Conflict('verification_failed', {
      reason: 'sha256_mismatch',
    })
  }

  const verified = await withTenant(tenant, async (client) => {
    const r = await client.query<AttachmentRow>(
      `UPDATE attachments SET verified_at = now() WHERE id = $1
        RETURNING id, vault_id, note_id, key_r2, mime, size_bytes, sha256, verified_at, created_at`,
      [params.id],
    )
    return r.rows[0] ?? null
  })
  if (!verified) throw NotFound('attachment not found')

  const presigned = await presignGet(verified.key_r2)
  return c.json(toAttachmentShape(verified, presigned.url))
})

// ── GET /attachments/:id  → 302 to presigned URL ─────────────────────────

attachments.get('/attachments/:id', async (c) => {
  const params = AttachmentIdParam.parse(c.req.param())
  const tenant = c.get('tenant')

  const row = await withTenant(tenant, async (client) => {
    const r = await client.query<AttachmentRow>(
      `SELECT id, vault_id, note_id, key_r2, mime, size_bytes, sha256, verified_at, created_at
         FROM attachments
        WHERE id = $1`,
      [params.id],
    )
    return r.rows[0] ?? null
  })
  if (!row) throw NotFound('attachment not found')
  if (!row.verified_at) throw Conflict('not_verified')

  const presigned = await presignGet(row.key_r2)
  return c.redirect(presigned.url, 302)
})

// ── DELETE /attachments/:id ──────────────────────────────────────────────

attachments.delete('/attachments/:id', async (c) => {
  const params = AttachmentIdParam.parse(c.req.param())
  const tenant = c.get('tenant')

  const row = await withTenant(tenant, async (client) => {
    // Detach from any note first so the editor stops linking. We keep the
    // metadata row around until the r2-gc worker confirms the object was
    // removed from the bucket — see ADR-0116 §7.
    const r = await client.query<{ id: string }>(
      `UPDATE attachments
          SET note_id = NULL
        WHERE id = $1
        RETURNING id`,
      [params.id],
    )
    return r.rows[0] ?? null
  })
  if (!row) throw NotFound('attachment not found')

  await scheduleR2Gc({ subscriptionId: tenant.subscriptionId, attachmentId: row.id })
  return c.body(null, 204)
})

// ── Shape helpers ────────────────────────────────────────────────────────

function toAttachmentShape(row: AttachmentRow, url: string): Attachment {
  return {
    id: row.id,
    vaultId: row.vault_id,
    noteId: row.note_id,
    mime: row.mime,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    url,
  }
}
