// VaultAdapter — the seam between the React UI and whatever backend it is
// talking to (Tauri commands locally, HTTP API in the web build).
//
// Keep this surface small: it is the public contract every adapter must
// satisfy and every UI feature must funnel through. Anything Tauri-specific
// (filesystem watchers, Git status, OS-native menus, CLI agents) does NOT
// belong here.

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

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface CreateNoteRequest {
  folderId?: string | null
  title: string
  bodyMd?: string
  frontmatter?: Record<string, unknown>
}

export interface SaveNoteRequest {
  bodyMd: string
  frontmatter: Record<string, unknown>
  expectedVersion: number
}

export interface RenameResult {
  affectedNoteIds: string[]
  updatedLinkCount: number
}

export interface SearchResult {
  noteId: string
  title: string
  snippet: string
  score: number
}

export interface SearchResponse {
  results: SearchResult[]
  query: string
  mode: 'full' | 'prefix'
  elapsedMs: number
}

export interface AttachmentMeta {
  mime: string
  size: number
  sha256: string
  filename: string
  noteId?: string | null
}

export interface Attachment {
  id: string
  vaultId: string
  noteId: string | null
  mime: string
  sizeBytes: number
  sha256: string
  url: string
}

export interface AiStreamRequest {
  vaultId: string
  model: string
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>
  tools?: Array<{ name: string; description: string; schema: Record<string, unknown> }>
}

export type AiStreamEvent =
  | { type: 'token'; delta: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; id: string }
  | { type: 'tool_result'; id: string; result: unknown }
  | { type: 'usage'; promptTokens: number; completionTokens: number; creditsRemaining: number }
  | { type: 'done' }
  | { type: 'error'; message: string }

export interface VaultAdapter {
  listVaults(): Promise<Vault[]>
  getVault(id: string): Promise<Vault>

  listFolders(vaultId: string): Promise<Folder[]>
  listNotes(
    vaultId: string,
    opts?: { folderId?: string | null; limit?: number; cursor?: string | null },
  ): Promise<Page<NoteSummary>>
  getNote(noteId: string): Promise<Note>
  createNote(vaultId: string, body: CreateNoteRequest): Promise<Note>
  saveNote(noteId: string, body: SaveNoteRequest): Promise<{ version: number }>
  deleteNote(noteId: string): Promise<void>

  rename(vaultId: string, fromPath: string, toPath: string): Promise<RenameResult>
  search(vaultId: string, query: string, mode?: 'full' | 'prefix'): Promise<SearchResponse>

  uploadAttachment(file: Blob, meta: AttachmentMeta): Promise<Attachment>
  getAttachmentUrl(id: string): Promise<string>

  /**
   * Open an SSE stream of AI events. Resolves with the AbortController used to
   * close the upstream connection. Implementations must guarantee `onEvent`
   * is invoked synchronously per SSE frame.
   */
  streamAi(req: AiStreamRequest, onEvent: (e: AiStreamEvent) => void): Promise<AbortController>
}
