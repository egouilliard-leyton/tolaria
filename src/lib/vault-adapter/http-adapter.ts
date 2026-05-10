// HTTP-backed VaultAdapter for the Tolaria web SaaS build.
//
// All methods translate the Camel-case TypeScript contract in `types.ts`
// into the REST surface defined by docs/ARCHITECTURE-WEB-SAAS.md §5. The
// server side speaks snake_case (e.g. `expected_version`, `body_md`); the
// adapter is the single boundary where that translation happens, so React
// components only ever see the camelCase contract.

import { ApiClient, ApiError, getAccessToken } from './api-client.js'
import type {
  Attachment,
  AttachmentMeta,
  AiStreamEvent,
  AiStreamRequest,
  CreateNoteRequest,
  Folder,
  Note,
  NoteSummary,
  Page,
  RenameResult,
  SaveNoteRequest,
  SearchResponse,
  Vault,
  VaultAdapter,
} from './types.js'

interface VaultDto {
  id: string
  slug: string
  name: string
  created_at: string
  settings?: Record<string, unknown>
}

interface FolderDto {
  id: string
  vault_id: string
  parent_id: string | null
  name: string
  position: number
  updated_at: string
}

interface NoteSummaryDto {
  id: string
  vault_id: string
  folder_id: string | null
  slug: string
  title: string
  modified_at: string
  word_count: number
}

interface NoteDto extends NoteSummaryDto {
  body_md: string
  frontmatter: Record<string, unknown>
  version: number
  created_at: string
}

interface PageDto<T> {
  items: T[]
  next_cursor: string | null
}

interface SearchResultDto {
  note_id: string
  title: string
  snippet: string
  score: number
}

interface SearchResponseDto {
  results: SearchResultDto[]
  query: string
  mode: 'full' | 'prefix'
  elapsed_ms: number
}

interface PresignedAttachmentDto {
  id: string
  put_url: string
  get_url: string
  key: string
  required_headers?: Record<string, string>
  /**
   * Server-required value for the `x-amz-meta-sha256` header on the PUT.
   * Returned separately so the client doesn't have to recompute or trust
   * its own digest at upload time.
   */
  sha256_header?: string
}

interface AttachmentDto {
  id: string
  vault_id: string
  note_id: string | null
  mime: string
  size_bytes: number
  sha256: string
  url: string
}

export interface HttpVaultAdapterOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
  onAuthError?: (error: ApiError) => void
}

export class HttpVaultAdapter implements VaultAdapter {
  private readonly client: ApiClient
  private readonly rawFetch: typeof fetch

  constructor(options: HttpVaultAdapterOptions) {
    this.client = new ApiClient(options)
    this.rawFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  // --- Vaults ----------------------------------------------------------

  async listVaults(): Promise<Vault[]> {
    const dtos = await this.client.getJson<VaultDto[]>('/vaults')
    return dtos.map(toVault)
  }

  async getVault(id: string): Promise<Vault> {
    const dto = await this.client.getJson<VaultDto>(`/vaults/${encodeURIComponent(id)}`)
    return toVault(dto)
  }

  // --- Folders ---------------------------------------------------------

  async listFolders(vaultId: string): Promise<Folder[]> {
    const dtos = await this.client.getJson<FolderDto[]>(
      `/vaults/${encodeURIComponent(vaultId)}/folders`,
    )
    return dtos.map(toFolder)
  }

  // --- Notes -----------------------------------------------------------

  async listNotes(
    vaultId: string,
    opts: { folderId?: string | null; limit?: number; cursor?: string | null } = {},
  ): Promise<Page<NoteSummary>> {
    const params = new URLSearchParams()
    if (opts.folderId !== undefined && opts.folderId !== null) params.set('folder_id', opts.folderId)
    if (opts.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts.cursor) params.set('cursor', opts.cursor)
    const qs = params.toString()
    const path = `/vaults/${encodeURIComponent(vaultId)}/notes${qs ? `?${qs}` : ''}`
    const page = await this.client.getJson<PageDto<NoteSummaryDto>>(path)
    return {
      items: page.items.map(toNoteSummary),
      nextCursor: page.next_cursor,
    }
  }

  async getNote(noteId: string): Promise<Note> {
    const dto = await this.client.getJson<NoteDto>(`/notes/${encodeURIComponent(noteId)}`)
    return toNote(dto)
  }

  async createNote(vaultId: string, body: CreateNoteRequest): Promise<Note> {
    const dto = await this.client.requestJson<NoteDto>(
      `/vaults/${encodeURIComponent(vaultId)}/notes`,
      {
        method: 'POST',
        body: JSON.stringify({
          folder_id: body.folderId ?? null,
          title: body.title,
          body_md: body.bodyMd ?? '',
          frontmatter: body.frontmatter ?? {},
        }),
      },
    )
    return toNote(dto)
  }

  async saveNote(noteId: string, body: SaveNoteRequest): Promise<{ version: number }> {
    const result = await this.client.requestJson<{ version: number }>(
      `/notes/${encodeURIComponent(noteId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          body_md: body.bodyMd,
          frontmatter: body.frontmatter,
          expected_version: body.expectedVersion,
        }),
      },
    )
    return { version: result.version }
  }

  async deleteNote(noteId: string): Promise<void> {
    await this.client.request(`/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' })
  }

  // --- Rename + search -------------------------------------------------

  async rename(vaultId: string, fromPath: string, toPath: string): Promise<RenameResult> {
    const dto = await this.client.requestJson<{ affected_note_ids: string[]; updated_link_count: number }>(
      `/vaults/${encodeURIComponent(vaultId)}/rename`,
      {
        method: 'POST',
        body: JSON.stringify({ from_path: fromPath, to_path: toPath }),
      },
    )
    return {
      affectedNoteIds: dto.affected_note_ids,
      updatedLinkCount: dto.updated_link_count,
    }
  }

  async search(
    vaultId: string,
    query: string,
    mode: 'full' | 'prefix' = 'full',
  ): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query, mode })
    const dto = await this.client.getJson<SearchResponseDto>(
      `/vaults/${encodeURIComponent(vaultId)}/search?${params.toString()}`,
    )
    return {
      query: dto.query,
      mode: dto.mode,
      elapsedMs: dto.elapsed_ms,
      results: dto.results.map((r) => ({
        noteId: r.note_id,
        title: r.title,
        snippet: r.snippet,
        score: r.score,
      })),
    }
  }

  // --- Attachments -----------------------------------------------------

  async uploadAttachment(file: Blob, meta: AttachmentMeta): Promise<Attachment> {
    const sha256 = meta.sha256 || (await sha256Hex(file))
    const presigned = await this.client.requestJson<PresignedAttachmentDto>(
      `/vaults/${encodeURIComponent(vaultIdFromMeta(meta))}/attachments`,
      {
        method: 'POST',
        body: JSON.stringify({
          mime: meta.mime,
          size: meta.size,
          sha256,
          filename: meta.filename,
          note_id: meta.noteId ?? null,
        }),
      },
    )

    // PUT the bytes directly to R2. We send only the headers the server
    // told us to send — including `x-amz-meta-sha256` so R2 records the
    // digest the API will verify in the next step.
    const putHeaders: HeadersInit = {
      'Content-Type': meta.mime,
      'x-amz-meta-sha256': presigned.sha256_header ?? sha256,
      ...(presigned.required_headers ?? {}),
    }
    const putResponse = await this.rawFetch(presigned.put_url, {
      method: 'PUT',
      body: file,
      headers: putHeaders,
    })
    if (!putResponse.ok) {
      throw new ApiError(putResponse.status, {
        code: 'attachment_upload_failed',
        message: `R2 PUT failed (${putResponse.status})`,
      })
    }

    const verified = await this.client.requestJson<AttachmentDto>(
      `/attachments/${encodeURIComponent(presigned.id)}/verify`,
      { method: 'POST' },
    )
    return toAttachment(verified)
  }

  async getAttachmentUrl(id: string): Promise<string> {
    // Server returns 302 to a time-limited GET URL. Try `redirect: 'manual'`
    // first; in browsers that block reading the Location header on opaque
    // redirects we fall back to the API endpoint itself, which the
    // <img>/<a> tag will follow on its own.
    try {
      const response = await this.rawFetch(this.client.url(`/attachments/${encodeURIComponent(id)}`), {
        method: 'GET',
        redirect: 'manual',
        credentials: 'include',
        headers: getAccessToken() ? { Authorization: `Bearer ${getAccessToken() ?? ''}` } : {},
      })
      const location = response.headers.get('location')
      if (location) return location
    } catch {
      // network or CORS rejected the manual redirect; fall through
    }
    return this.client.url(`/attachments/${encodeURIComponent(id)}`)
  }

  // --- AI streaming ----------------------------------------------------

  async streamAi(
    req: AiStreamRequest,
    onEvent: (event: AiStreamEvent) => void,
  ): Promise<AbortController> {
    const controller = new AbortController()
    // Token lives in memory; pass it on the query string because the
    // browser EventSource API cannot set Authorization headers and we
    // mirror that constraint here for parity with future EventSource use.
    const token = getAccessToken()
    const params = new URLSearchParams()
    if (token) params.set('access_token', token)
    const path = `/ai/chat${params.toString() ? `?${params.toString()}` : ''}`

    void this.client
      .streamSse(
        path,
        {
          method: 'POST',
          body: JSON.stringify({
            vault_id: req.vaultId,
            model: req.model,
            messages: req.messages,
            tools: req.tools ?? [],
          }),
        },
        (frame) => {
          const event = mapSseToAiEvent(frame.type, frame.json, frame.data)
          if (event) onEvent(event)
        },
        controller.signal,
      )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'AI stream failed'
        onEvent({ type: 'error', message })
      })

    return controller
  }
}

// --- DTO converters ----------------------------------------------------

function toVault(dto: VaultDto): Vault {
  return {
    id: dto.id,
    slug: dto.slug,
    name: dto.name,
    createdAt: dto.created_at,
    settings: dto.settings ?? {},
  }
}

function toFolder(dto: FolderDto): Folder {
  return {
    id: dto.id,
    vaultId: dto.vault_id,
    parentId: dto.parent_id,
    name: dto.name,
    position: dto.position,
    updatedAt: dto.updated_at,
  }
}

function toNoteSummary(dto: NoteSummaryDto): NoteSummary {
  return {
    id: dto.id,
    vaultId: dto.vault_id,
    folderId: dto.folder_id,
    slug: dto.slug,
    title: dto.title,
    modifiedAt: dto.modified_at,
    wordCount: dto.word_count,
  }
}

function toNote(dto: NoteDto): Note {
  return {
    ...toNoteSummary(dto),
    bodyMd: dto.body_md,
    frontmatter: dto.frontmatter ?? {},
    version: dto.version,
    createdAt: dto.created_at,
  }
}

function toAttachment(dto: AttachmentDto): Attachment {
  return {
    id: dto.id,
    vaultId: dto.vault_id,
    noteId: dto.note_id,
    mime: dto.mime,
    sizeBytes: dto.size_bytes,
    sha256: dto.sha256,
    url: dto.url,
  }
}

function mapSseToAiEvent(type: string, json: unknown, raw: string): AiStreamEvent | null {
  if (type === 'done') return { type: 'done' }
  if (type === 'error') {
    const message = isRecord(json) && typeof json.message === 'string' ? json.message : raw
    return { type: 'error', message }
  }
  if (type === 'usage' && isRecord(json)) {
    return {
      type: 'usage',
      promptTokens: numberOr(json.prompt_tokens, 0),
      completionTokens: numberOr(json.completion_tokens, 0),
      creditsRemaining: numberOr(json.credits_remaining, 0),
    }
  }
  if (type === 'tool_call' && isRecord(json)) {
    return {
      type: 'tool_call',
      id: stringOr(json.id, ''),
      name: stringOr(json.name, ''),
      args: isRecord(json.args) ? (json.args as Record<string, unknown>) : {},
    }
  }
  if (type === 'tool_result' && isRecord(json)) {
    return { type: 'tool_result', id: stringOr(json.id, ''), result: json.result }
  }
  // Default: token stream. Server may either send {type:'token',delta:'…'}
  // or just {delta:'…'} on the default `message` event.
  if (isRecord(json) && typeof json.delta === 'string') {
    return { type: 'token', delta: json.delta }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * `AttachmentMeta` does not carry the vault id (the server figures that
 * out from the note id in the desktop adapter). For the HTTP path we need
 * an explicit vault id, but we don't want to widen the interface in
 * `types.ts` mid-port. Until callers upgrade to a `vaultId`-bearing
 * variant, expect a `vaultId` field smuggled on the meta object.
 */
function vaultIdFromMeta(meta: AttachmentMeta & { vaultId?: string }): string {
  if (typeof meta.vaultId === 'string' && meta.vaultId.length > 0) return meta.vaultId
  throw new Error(
    'HttpVaultAdapter.uploadAttachment: AttachmentMeta is missing `vaultId`. ' +
      'Add `vaultId` to the meta argument when calling from web build code paths.',
  )
}

/** SHA-256 hex digest of a Blob using the browser SubtleCrypto API. */
async function sha256Hex(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}
