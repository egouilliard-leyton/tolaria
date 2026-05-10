// Zod schemas for every request body and query string.
// We `.strict()` everywhere so unknown fields are rejected up front and the
// route handlers don't have to think about extra keys creeping in.
//
// The inferred TS types are re-exported so route handlers can stay terse.

import { z } from 'zod'

// ── Primitives ──────────────────────────────────────────────────────────────

export const uuid = z.string().uuid()

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(slugRegex, 'slug must be kebab-case (lowercase letters, digits, hyphens)')

const cursorSchema = z.string().min(1).max(512).optional()
const limitSchema = z.coerce.number().int().min(1).max(200).default(50)

const trimmedName = z.string().trim().min(1).max(200)

// frontmatter and settings are arbitrary JSON objects, but we restrict to plain
// records so callers can't smuggle non-object payloads in.
const jsonRecord: z.ZodType<Record<string, unknown>> = z
  .record(z.unknown())
  .refine((v) => v !== null && typeof v === 'object' && !Array.isArray(v), {
    message: 'must be a JSON object',
  })

// ── Vaults ──────────────────────────────────────────────────────────────────

export const VaultIdParam = z.object({ id: uuid }).strict()
export type VaultIdParam = z.infer<typeof VaultIdParam>

export const CreateVaultBody = z
  .object({
    name: trimmedName,
    slug: slugSchema.optional(),
    settings: jsonRecord.optional(),
  })
  .strict()
export type CreateVaultBody = z.infer<typeof CreateVaultBody>

export const UpdateVaultBody = z
  .object({
    name: trimmedName.optional(),
    settings: jsonRecord.optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.settings !== undefined, {
    message: 'at least one of name, settings is required',
  })
export type UpdateVaultBody = z.infer<typeof UpdateVaultBody>

// ── Folders ─────────────────────────────────────────────────────────────────

export const VaultIdRouteParam = z.object({ vaultId: uuid }).strict()
export type VaultIdRouteParam = z.infer<typeof VaultIdRouteParam>

export const FolderIdParam = z.object({ id: uuid }).strict()
export type FolderIdParam = z.infer<typeof FolderIdParam>

export const CreateFolderBody = z
  .object({
    parentId: uuid.nullable().optional(),
    name: trimmedName,
    position: z.number().int().min(0).optional(),
  })
  .strict()
export type CreateFolderBody = z.infer<typeof CreateFolderBody>

export const UpdateFolderBody = z
  .object({
    name: trimmedName.optional(),
    parentId: uuid.nullable().optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.parentId !== undefined || v.position !== undefined,
    { message: 'at least one of name, parentId, position is required' },
  )
export type UpdateFolderBody = z.infer<typeof UpdateFolderBody>

// ── Notes ───────────────────────────────────────────────────────────────────

export const NoteIdParam = z.object({ id: uuid }).strict()
export type NoteIdParam = z.infer<typeof NoteIdParam>

export const ListNotesQuery = z
  .object({
    folderId: z.union([uuid, z.literal('null')]).optional(),
    limit: limitSchema,
    cursor: cursorSchema,
  })
  .strict()
export type ListNotesQuery = z.infer<typeof ListNotesQuery>

export const CreateNoteBody = z
  .object({
    folderId: uuid.nullable().optional(),
    title: trimmedName,
    bodyMd: z.string().max(10_000_000).optional(),
    frontmatter: jsonRecord.optional(),
  })
  .strict()
export type CreateNoteBody = z.infer<typeof CreateNoteBody>

export const SaveNoteBody = z
  .object({
    bodyMd: z.string().max(10_000_000),
    frontmatter: jsonRecord,
    expectedVersion: z.number().int().min(1),
  })
  .strict()
export type SaveNoteBody = z.infer<typeof SaveNoteBody>

// ── Search ──────────────────────────────────────────────────────────────────

export const SearchQuery = z
  .object({
    q: z.string().min(1).max(500),
    mode: z.enum(['full', 'prefix']).default('full'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()
export type SearchQuery = z.infer<typeof SearchQuery>

// ── Attachments ─────────────────────────────────────────────────────────────

// MIME allowlist — see ADR-0116 §3. The boundary check intentionally lives
// in the route, not in the Zod schema, because we want a 400 with the
// canonical `invalid_input` shape and a clear message.
export const ATTACHMENT_MIME_PREFIX_ALLOWLIST = ['image/', 'audio/', 'video/'] as const
export const ATTACHMENT_MIME_EXACT_ALLOWLIST = ['application/pdf', 'text/plain'] as const

export function isAllowedAttachmentMime(mime: string): boolean {
  if (ATTACHMENT_MIME_EXACT_ALLOWLIST.includes(mime as (typeof ATTACHMENT_MIME_EXACT_ALLOWLIST)[number])) {
    return true
  }
  return ATTACHMENT_MIME_PREFIX_ALLOWLIST.some((p) => mime.startsWith(p))
}

// MVP plan-size cap. TODO: gate on `subscriptions.plan` once billing lands;
// for now we hardcode the same cap for everyone.
export const ATTACHMENT_MAX_SIZE_BYTES = 50 * 1024 * 1024

// MIME shape: a strict-ish RFC 6838 token/subtype with optional parameters
// stripped at the boundary. We deliberately accept a fairly loose pattern
// here and rely on the allowlist check above to actually decide.
const mimeSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/, 'invalid mime type')

const sha256Hex = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/, 'sha256 must be 64 lowercase hex characters')

const filenameSchema = z.string().trim().min(1).max(400)

export const AttachmentIdParam = z.object({ id: uuid }).strict()
export type AttachmentIdParam = z.infer<typeof AttachmentIdParam>

export const CreateAttachmentBody = z
  .object({
    mime: mimeSchema,
    size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    sha256: sha256Hex,
    filename: filenameSchema,
    noteId: uuid.optional(),
  })
  .strict()
export type CreateAttachmentBody = z.infer<typeof CreateAttachmentBody>

// ── Rename ──────────────────────────────────────────────────────────────────

// fromPath / toPath are wikilink targets — usually equal to a note slug or a
// nested path. We keep them loose enough to allow anything a wikilink can
// contain except the closing brackets and the alias separator.
const wikilinkTarget = z
  .string()
  .min(1)
  .max(400)
  .regex(/^[^\[\]\|\n\r]+$/, 'path must not contain [, ], |, or newlines')

export const RenameBody = z
  .object({
    fromPath: wikilinkTarget,
    toPath: wikilinkTarget,
  })
  .strict()
  .refine((v) => v.fromPath !== v.toPath, {
    message: 'fromPath and toPath must differ',
  })
export type RenameBody = z.infer<typeof RenameBody>
