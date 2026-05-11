// TauriVaultAdapter — desktop implementation of the VaultAdapter contract.
//
// The desktop "vault" model is a Git repository on the filesystem. Notes
// are addressed by absolute file path, folders are real directories, and
// versioning is whatever Git records — there is no integer counter. The
// web contract is UUID-keyed, version-numbered and SaaS-tenant-scoped. To
// bridge the two we treat the on-disk identifiers as opaque strings:
//
//   - `vaultId`  -> the vault's absolute filesystem path on disk
//   - `noteId`   -> the note's absolute filesystem path on disk
//   - `folderId` -> the folder's vault-relative path (forward-slash form)
//
// Where the desktop genuinely cannot satisfy the web shape — most notably
// `version`-based optimistic concurrency and `Attachment` records keyed by
// UUID — a `// CONTRACT GAP:` comment documents the impedance and the
// method either throws a clear error or returns a best-effort synthetic
// record. The migration tool (`useSyncToCloud`) only needs the methods
// that are wired here; the editor still talks to Tauri directly for now.
//
// All methods load `@tauri-apps/api/core` (and `event`) lazily so the web
// build, which aliases those modules to a throw-on-call stub, does not
// break at module-eval time.

import type {
  Attachment,
  AttachmentMeta,
  AiStreamEvent,
  AiStreamRequest,
  CreateNoteRequest,
  CreateVaultRequest,
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

/** Thrown by adapter methods that have not been ported to desktop yet. */
export class TauriAdapterNotImplementedError extends Error {
  readonly method: string

  constructor(method: string, reason?: string) {
    const suffix = reason ? ` (${reason})` : ''
    super(`TauriVaultAdapter.${method} is not yet wired in desktop adapter${suffix}`)
    this.name = 'TauriAdapterNotImplementedError'
    this.method = method
  }
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
type ConvertFileSrcFn = (path: string, protocol?: string) => string
type ListenFn = <T>(
  event: string,
  handler: (event: { payload: T }) => void,
) => Promise<() => void>

async function loadInvoke(): Promise<InvokeFn> {
  const mod = (await import('@tauri-apps/api/core')) as { invoke: InvokeFn }
  return mod.invoke
}

async function loadConvertFileSrc(): Promise<ConvertFileSrcFn> {
  const mod = (await import('@tauri-apps/api/core')) as {
    convertFileSrc: ConvertFileSrcFn
  }
  return mod.convertFileSrc
}

async function loadListen(): Promise<ListenFn> {
  const mod = (await import('@tauri-apps/api/event')) as { listen: ListenFn }
  return mod.listen
}

// ── Native types we round-trip through invoke() ─────────────────────────
// These mirror the Rust structs in src-tauri/src/vault_list.rs and
// src-tauri/src/vault/entry.rs. They are intentionally narrow — only the
// fields the adapter actually reads.

interface VaultListEntryDto {
  label: string
  path: string
  alias?: string | null
  color?: string | null
  icon?: string | null
  mounted?: boolean | null
}

interface VaultListDto {
  vaults: VaultListEntryDto[]
  active_vault?: string | null
  default_workspace_path?: string | null
  hidden_defaults?: string[]
}

interface VaultEntryDto {
  path: string
  filename: string
  title: string
  modifiedAt?: number | null
  createdAt?: number | null
  fileSize: number
  archived: boolean
}

interface FolderNodeDto {
  name: string
  path: string
  children: FolderNodeDto[]
}

interface SearchResultDto {
  path: string
  title: string
  snippet: string
  score: number
}

interface SearchResponseDto {
  results: SearchResultDto[]
  query: string
  mode: string
  elapsed_ms: number
}

interface FolderRenameResultDto {
  old_path: string
  new_path: string
  affected_notes?: string[]
  updated_link_count?: number
}

// ── Adapter ────────────────────────────────────────────────────────────

export class TauriVaultAdapter implements VaultAdapter {
  async listVaults(): Promise<Vault[]> {
    const invoke = await loadInvoke()
    const list = await invoke<VaultListDto>('load_vault_list', {})
    return (list.vaults ?? []).map(vaultListEntryToVault)
  }

  async getVault(id: string): Promise<Vault> {
    const invoke = await loadInvoke()
    const list = await invoke<VaultListDto>('load_vault_list', {})
    const match = (list.vaults ?? []).find((v) => v.path === id)
    if (!match) {
      throw new TauriAdapterNotImplementedError(
        'getVault',
        `no vault registered with path ${id}`,
      )
    }
    return vaultListEntryToVault(match)
  }

  async createVault(input: CreateVaultRequest): Promise<Vault> {
    // CONTRACT GAP: the desktop `create_empty_vault` command takes a path on
    // disk, not a name+slug pair, and there is no equivalent of the server
    // `subscription_id`/`id` UUID columns. We accept the migration tool's
    // current usage (create a destination by name) by treating `slug` as a
    // folder name under the default workspace root, then registering the new
    // path in the vault list. The returned Vault.id is the absolute path so
    // every subsequent adapter call can address it.
    const invoke = await loadInvoke()
    const slug = (input.slug ?? input.name).trim()
    if (!slug) {
      throw new Error('TauriVaultAdapter.createVault: name or slug is required')
    }
    const list = await invoke<VaultListDto>('load_vault_list', {})
    const workspaceRoot =
      list.default_workspace_path ??
      (await invoke<string>('get_default_vault_path', {}).catch(() => ''))
    if (!workspaceRoot) {
      throw new TauriAdapterNotImplementedError(
        'createVault',
        'no default workspace path is registered',
      )
    }
    const sep = workspaceRoot.includes('\\') ? '\\' : '/'
    const path = `${workspaceRoot.replace(/[\\/]+$/, '')}${sep}${slug}`
    await invoke<string>('create_empty_vault', { path })
    const updated: VaultListDto = {
      vaults: [...list.vaults, { label: input.name, path }],
      active_vault: list.active_vault ?? null,
      default_workspace_path: list.default_workspace_path ?? null,
      hidden_defaults: list.hidden_defaults ?? [],
    }
    await invoke<void>('save_vault_list', { list: updated })
    return {
      id: path,
      slug,
      name: input.name,
      createdAt: new Date().toISOString(),
      settings: input.settings ?? {},
    }
  }

  async listFolders(vaultId: string): Promise<Folder[]> {
    const invoke = await loadInvoke()
    const tree = await invoke<FolderNodeDto[]>('list_vault_folders', { path: vaultId })
    // Flatten the tree depth-first so consumers iterating linearly see
    // parents before children. The returned `id` is the vault-relative
    // folder path (a stable opaque string on desktop).
    return flattenFolderTree(tree, null, vaultId, 0)
  }

  async listNotes(
    vaultId: string,
    opts: { folderId?: string | null; limit?: number; cursor?: string | null } = {},
  ): Promise<Page<NoteSummary>> {
    const invoke = await loadInvoke()
    const entries = await invoke<VaultEntryDto[]>('list_vault', { path: vaultId })

    // Filter by folder when requested. `folderId` is the vault-relative
    // folder path; a leading-prefix match selects descendants.
    const folderPrefix = normalizeFolderId(opts.folderId)
    const filtered = entries
      .filter((e) => !e.archived)
      .filter((e) => {
        if (folderPrefix === null) return true
        const rel = vaultRelativePath(vaultId, e.path)
        if (folderPrefix === '') {
          // root: notes with no folder component
          return !rel.includes('/')
        }
        return rel.startsWith(`${folderPrefix}/`)
      })
      .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))

    // Cursor-based pagination: the cursor is the index of the next item.
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500))
    const start = opts.cursor ? Math.max(0, Number.parseInt(opts.cursor, 10)) : 0
    const slice = filtered.slice(start, start + limit)
    const nextCursor =
      start + limit < filtered.length ? String(start + limit) : null

    return {
      items: slice.map((entry) => vaultEntryToNoteSummary(entry, vaultId)),
      nextCursor,
    }
  }

  async getNote(noteId: string): Promise<Note> {
    const invoke = await loadInvoke()
    const content = await invoke<string>('get_note_content', { path: noteId })
    // CONTRACT GAP: the desktop has no integer `version` counter; we
    // synthesize 0. Callers that round-trip through `saveNote` must be
    // tolerant of `expectedVersion` being advisory only.
    return {
      id: noteId,
      vaultId: '',
      folderId: null,
      slug: noteId,
      title: noteId,
      modifiedAt: new Date().toISOString(),
      wordCount: content.split(/\s+/).filter(Boolean).length,
      bodyMd: content,
      frontmatter: {},
      version: 0,
      createdAt: new Date(0).toISOString(),
    }
  }

  async createNote(vaultId: string, body: CreateNoteRequest): Promise<Note> {
    const invoke = await loadInvoke()
    const folder = normalizeFolderId(body.folderId)
    const filename = `${slugifyTitle(body.title) || 'untitled'}.md`
    const relative = folder ? `${folder}/${filename}` : filename
    const sep = vaultId.includes('\\') ? '\\' : '/'
    const notePath = `${vaultId.replace(/[\\/]+$/, '')}${sep}${relative.replace(/\//g, sep)}`
    const content = body.bodyMd ?? ''
    await invoke<void>('create_note_content', {
      path: notePath,
      content,
      vaultPath: vaultId,
    })
    // CONTRACT GAP: desktop has no `version` counter and no `id` distinct
    // from the path. Synthesize 1.
    return {
      id: notePath,
      vaultId,
      folderId: body.folderId ?? null,
      slug: filename.replace(/\.md$/i, ''),
      title: body.title,
      modifiedAt: new Date().toISOString(),
      wordCount: content.split(/\s+/).filter(Boolean).length,
      bodyMd: content,
      frontmatter: body.frontmatter ?? {},
      version: 1,
      createdAt: new Date().toISOString(),
    }
  }

  async saveNote(noteId: string, body: SaveNoteRequest): Promise<{ version: number }> {
    const invoke = await loadInvoke()
    // CONTRACT GAP: `expectedVersion` is ignored — desktop has no
    // optimistic-concurrency seam. The returned version is mirrored from
    // the request so callers that increment monotonically stay sane.
    await invoke<void>('save_note_content', { path: noteId, content: body.bodyMd })
    return { version: body.expectedVersion + 1 }
  }

  async deleteNote(noteId: string): Promise<void> {
    const invoke = await loadInvoke()
    await invoke<void>('delete_note', { path: noteId })
  }

  async rename(vaultId: string, fromPath: string, toPath: string): Promise<RenameResult> {
    const invoke = await loadInvoke()
    // Heuristic: if either path ends with `.md`, treat as a note rename via
    // the wikilink updater. Otherwise treat as a folder rename. The desktop
    // commands do not return the SaaS `affected_note_ids` / `updated_link_count`
    // shape directly; we adapt as best we can.
    const isNote = /\.md$/i.test(fromPath) || /\.md$/i.test(toPath)
    if (isNote) {
      // CONTRACT GAP: `update_wikilinks_for_renames` exists but its arg
      // shape is a batch of {oldPath, newPath}; many call sites also pass a
      // vault root. The web contract returns affected note ids and link
      // count; the desktop returns neither directly. Fan out a single
      // rename and report zero affected ids — callers must fall back to
      // re-listing notes.
      await invoke<unknown>('update_wikilinks_for_renames', {
        vaultPath: vaultId,
        renames: [{ oldPath: fromPath, newPath: toPath }],
      }).catch(() => undefined)
      return { affectedNoteIds: [], updatedLinkCount: 0 }
    }
    const newName = toPath.split(/[\\/]/).pop() ?? toPath
    const result = await invoke<FolderRenameResultDto>('rename_vault_folder', {
      vaultPath: vaultId,
      folderPath: fromPath,
      newName,
    })
    return {
      affectedNoteIds: result.affected_notes ?? [],
      updatedLinkCount: result.updated_link_count ?? 0,
    }
  }

  async search(
    vaultId: string,
    query: string,
    mode: 'full' | 'prefix' = 'full',
  ): Promise<SearchResponse> {
    const invoke = await loadInvoke()
    const dto = await invoke<SearchResponseDto>('search_vault', {
      vaultPath: vaultId,
      query,
      mode,
      limit: 20,
    })
    return {
      query: dto.query,
      mode: dto.mode === 'prefix' ? 'prefix' : 'full',
      elapsedMs: dto.elapsed_ms,
      results: dto.results.map((r) => ({
        // CONTRACT GAP: noteId is the file path on desktop, not a UUID.
        noteId: r.path,
        title: r.title,
        snippet: r.snippet,
        score: r.score,
      })),
    }
  }

  async uploadAttachment(file: Blob, meta: AttachmentMeta): Promise<Attachment> {
    // CONTRACT GAP: the desktop attachment surface is `copy_image_to_vault`,
    // which takes a source filesystem path — not a Blob. Browser-style
    // uploads from a Blob have no analogue in the desktop pipeline. The
    // method exists in the contract only because the HTTP adapter needs it
    // for browser drag-and-drop; on desktop the caller (e.g. the image
    // drop handler) should keep using `invoke('copy_image_to_vault', ...)`
    // directly. We throw rather than silently writing a temp file because
    // a silent path would lose the original filesystem location.
    void file
    void meta
    throw new TauriAdapterNotImplementedError(
      'uploadAttachment',
      'desktop accepts source paths, not Blobs — use copy_image_to_vault directly',
    )
  }

  async getAttachmentUrl(id: string): Promise<string> {
    // CONTRACT GAP: on desktop, `id` is treated as a vault-relative or
    // absolute path; `convertFileSrc` resolves it to the Tauri custom
    // asset:// URL the WKWebView can render.
    const convertFileSrc = await loadConvertFileSrc()
    return convertFileSrc(id)
  }

  async streamAi(
    req: AiStreamRequest,
    onEvent: (e: AiStreamEvent) => void,
  ): Promise<AbortController> {
    // CONTRACT GAP: desktop emits a richer event shape on the
    // `ai-model-stream` channel ({kind, text}/{kind:'Done'}/etc.) than the
    // web contract's narrow AiStreamEvent. We bridge the common cases
    // (text delta, done, error) and drop the rest. The desktop streamer
    // never reports per-frame token counts so `usage` events are not
    // emitted from this path — the web contract callers that depend on
    // remaining credits should hit the HTTP adapter when on synced mode.
    const invoke = await loadInvoke()
    const listen = await loadListen()
    const controller = new AbortController()

    const unlisten = await listen<DesktopAiEvent>('ai-model-stream', ({ payload }) => {
      const mapped = mapDesktopAiEvent(payload)
      if (mapped) onEvent(mapped)
    })

    controller.signal.addEventListener('abort', () => {
      try {
        unlisten()
      } catch {
        // best-effort: ignore unlisten failures
      }
    })

    // Fire the desktop command. Errors are surfaced through the event
    // callback so the caller's existing error-handling path covers both.
    void invoke<string>('stream_ai_model', {
      request: {
        provider: { id: req.model, name: req.model, base_url: null, models: [] },
        model_id: req.model,
        message: lastUserMessage(req.messages),
        system_prompt: firstSystemMessage(req.messages),
        api_key_override: null,
      },
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      onEvent({ type: 'error', message })
    })

    return controller
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

interface DesktopAiEvent {
  kind: string
  text?: string
  message?: string
}

function mapDesktopAiEvent(event: DesktopAiEvent): AiStreamEvent | null {
  if (!event || typeof event.kind !== 'string') return null
  switch (event.kind) {
    case 'TextDelta':
      return { type: 'token', delta: event.text ?? '' }
    case 'ThinkingDelta':
      return null
    case 'Done':
      return { type: 'done' }
    case 'Error':
      return { type: 'error', message: event.message ?? 'AI stream failed' }
    default:
      return null
  }
}

function lastUserMessage(messages: AiStreamRequest['messages']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user') return m.content
  }
  return messages[messages.length - 1]?.content ?? ''
}

function firstSystemMessage(messages: AiStreamRequest['messages']): string | null {
  for (const m of messages) {
    if (m.role === 'system') return m.content
  }
  return null
}

function vaultListEntryToVault(entry: VaultListEntryDto): Vault {
  // CONTRACT GAP: desktop has no createdAt for a vault list entry; the
  // synthetic timestamp keeps the field non-null for UI consumers.
  return {
    id: entry.path,
    slug: deriveSlug(entry.label, entry.path),
    name: entry.alias ?? entry.label ?? entry.path,
    createdAt: new Date(0).toISOString(),
    settings: {},
  }
}

function deriveSlug(label: string, path: string): string {
  const base = label || path.split(/[\\/]/).pop() || path
  return slugifyTitle(base) || 'vault'
}

function slugifyTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function flattenFolderTree(
  nodes: FolderNodeDto[],
  parentId: string | null,
  vaultId: string,
  position: number,
): Folder[] {
  const result: Folder[] = []
  nodes.forEach((node, idx) => {
    result.push({
      id: node.path,
      vaultId,
      parentId,
      name: node.name,
      position: position + idx,
      updatedAt: new Date(0).toISOString(),
    })
    if (node.children && node.children.length > 0) {
      result.push(...flattenFolderTree(node.children, node.path, vaultId, 0))
    }
  })
  return result
}

function vaultEntryToNoteSummary(entry: VaultEntryDto, vaultId: string): NoteSummary {
  const rel = vaultRelativePath(vaultId, entry.path)
  const lastSep = rel.lastIndexOf('/')
  const folderPath = lastSep === -1 ? null : rel.slice(0, lastSep)
  return {
    id: entry.path,
    vaultId,
    folderId: folderPath,
    slug: entry.filename.replace(/\.md$/i, ''),
    title: entry.title || entry.filename,
    modifiedAt: entry.modifiedAt
      ? new Date(entry.modifiedAt * 1000).toISOString()
      : new Date(0).toISOString(),
    // CONTRACT GAP: desktop entries don't carry a word count; this is a
    // cheap byte-based estimate that's good enough for UI ordering.
    wordCount: Math.max(0, Math.round(entry.fileSize / 6)),
  }
}

function vaultRelativePath(vaultId: string, fullPath: string): string {
  const normalizedVault = vaultId.replace(/[\\/]+$/, '')
  const normalizedFull = fullPath.replace(/\\/g, '/')
  const normalizedRoot = normalizedVault.replace(/\\/g, '/')
  if (normalizedFull.startsWith(`${normalizedRoot}/`)) {
    return normalizedFull.slice(normalizedRoot.length + 1)
  }
  return normalizedFull
}

function normalizeFolderId(folderId: string | null | undefined): string | null {
  if (folderId === undefined) return null
  if (folderId === null) return ''
  return folderId.replace(/^[\\/]+|[\\/]+$/g, '').replace(/\\/g, '/')
}
