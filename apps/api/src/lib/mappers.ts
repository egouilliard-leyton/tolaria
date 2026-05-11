// Map snake_case database rows into the snake_case JSON contract the SPA's
// HttpVaultAdapter expects (see `src/lib/vault-adapter/http-adapter.ts`).
//
// The wire format on `/vaults/*`, `/folders/*`, `/notes/*`, `/search`,
// `/rename`, `/attachments/*`, and `/ai/chat` is **snake_case**. The SPA is
// the single boundary that translates between the snake_case wire and its
// internal camelCase `VaultAdapter` types — see plan §6.
//
// Timestamps come back from `pg` as `Date` instances (per the default node-pg
// type parser); we always emit ISO-8601 strings so the API is stable
// regardless of pool config.

export interface VaultDto {
  id: string
  slug: string
  name: string
  created_at: string
  settings: Record<string, unknown>
}

export interface FolderDto {
  id: string
  vault_id: string
  parent_id: string | null
  name: string
  position: number
  updated_at: string
}

export interface NoteSummaryDto {
  id: string
  vault_id: string
  folder_id: string | null
  slug: string
  title: string
  modified_at: string
  word_count: number
}

export interface NoteDto extends NoteSummaryDto {
  body_md: string
  frontmatter: Record<string, unknown>
  version: number
  created_at: string
}

const iso = (v: Date | string): string =>
  v instanceof Date ? v.toISOString() : new Date(v).toISOString()

interface VaultRow {
  id: string
  slug: string
  name: string
  created_at: Date | string
  settings: Record<string, unknown>
}

export function toVault(row: VaultRow): VaultDto {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    created_at: iso(row.created_at),
    settings: row.settings ?? {},
  }
}

interface FolderRow {
  id: string
  vault_id: string
  parent_id: string | null
  name: string
  position: number
  updated_at: Date | string
}

export function toFolder(row: FolderRow): FolderDto {
  return {
    id: row.id,
    vault_id: row.vault_id,
    parent_id: row.parent_id,
    name: row.name,
    position: row.position,
    updated_at: iso(row.updated_at),
  }
}

interface NoteSummaryRow {
  id: string
  vault_id: string
  folder_id: string | null
  slug: string
  title: string
  modified_at: Date | string
  word_count: number
}

export function toNoteSummary(row: NoteSummaryRow): NoteSummaryDto {
  return {
    id: row.id,
    vault_id: row.vault_id,
    folder_id: row.folder_id,
    slug: row.slug,
    title: row.title,
    modified_at: iso(row.modified_at),
    word_count: row.word_count,
  }
}

interface NoteRow extends NoteSummaryRow {
  body_md: string
  frontmatter: Record<string, unknown>
  version: number
  created_at: Date | string
}

export function toNote(row: NoteRow): NoteDto {
  return {
    ...toNoteSummary(row),
    body_md: row.body_md,
    frontmatter: row.frontmatter ?? {},
    version: row.version,
    created_at: iso(row.created_at),
  }
}

/**
 * Cheap word count for new note bodies. The indexer recomputes it server-side
 * when it ingests the note, but we still need a sensible value at write time.
 */
export function wordCount(md: string): number {
  if (!md) return 0
  // Strip code fences and inline code to avoid counting backticks-as-words.
  const clean = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
  const matches = clean.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu)
  return matches ? matches.length : 0
}
