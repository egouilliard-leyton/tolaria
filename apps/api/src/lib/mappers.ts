// Map snake_case database rows into the camelCase JSON contract defined in
// `src/lib/vault-adapter/types.ts`. Keep the conversion in one place so route
// handlers only have to call a single function.
//
// Timestamps come back from `pg` as `Date` instances (per the default node-pg
// type parser); we always emit ISO-8601 strings so the API is stable
// regardless of pool config.
//
// The shapes below are intentional copies of the VaultAdapter contract types
// in `src/lib/vault-adapter/types.ts`. We don't import from outside this
// package's rootDir, but the field names and types must stay in lockstep.

export interface Vault {
  id: string
  slug: string
  name: string
  createdAt: string
  settings: Record<string, unknown>
}

export interface Folder {
  id: string
  vaultId: string
  parentId: string | null
  name: string
  position: number
  updatedAt: string
}

export interface NoteSummary {
  id: string
  vaultId: string
  folderId: string | null
  slug: string
  title: string
  modifiedAt: string
  wordCount: number
}

export interface Note extends NoteSummary {
  bodyMd: string
  frontmatter: Record<string, unknown>
  version: number
  createdAt: string
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

export function toVault(row: VaultRow): Vault {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    createdAt: iso(row.created_at),
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

export function toFolder(row: FolderRow): Folder {
  return {
    id: row.id,
    vaultId: row.vault_id,
    parentId: row.parent_id,
    name: row.name,
    position: row.position,
    updatedAt: iso(row.updated_at),
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

export function toNoteSummary(row: NoteSummaryRow): NoteSummary {
  return {
    id: row.id,
    vaultId: row.vault_id,
    folderId: row.folder_id,
    slug: row.slug,
    title: row.title,
    modifiedAt: iso(row.modified_at),
    wordCount: row.word_count,
  }
}

interface NoteRow extends NoteSummaryRow {
  body_md: string
  frontmatter: Record<string, unknown>
  version: number
  created_at: Date | string
}

export function toNote(row: NoteRow): Note {
  return {
    ...toNoteSummary(row),
    bodyMd: row.body_md,
    frontmatter: row.frontmatter ?? {},
    version: row.version,
    createdAt: iso(row.created_at),
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
