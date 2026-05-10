// TauriVaultAdapter — placeholder desktop implementation.
//
// The desktop app currently calls `invoke()` directly from React (133+ call
// sites). This file exists so the `VaultAdapter` interface is satisfied on
// desktop too, but the existing call sites are NOT migrated yet. The
// orchestrator will thread this adapter through the React tree once the
// web build is wired end-to-end.
//
// Why so many `Not yet wired in desktop adapter` throws?
//
//   The desktop "vault" model is a Git repository on the filesystem. Notes
//   are addressed by absolute file path; folders are real directories;
//   versioning is whatever Git records, not an integer counter; "search"
//   runs in-process through the tantivy-backed Rust commands. The web
//   contract is uuid-keyed, version-numbered, and SaaS-tenant-scoped. A
//   one-to-one Tauri mapping is not free — it requires a translation layer
//   that maps UUIDs to filesystem paths and back, plus a bridge for
//   optimistic concurrency that the desktop simply doesn't have today.
//
// What IS mapped right now:
//
//   - `saveNote` -> invoke('save_note_content', { path, content })
//     using `noteId` as the absolute path. `expectedVersion` is ignored
//     (desktop has no version counter); the returned version is mirrored
//     from the request so callers don't blow up.
//   - `deleteNote` -> invoke('delete_note', { path })
//   - `getNote` is stubbed (returns the file content via
//     `get_note_content`, leaves frontmatter empty and version=0). This is
//     enough for the editor to round-trip a save when the orchestrator
//     plumbs it in, but is not yet fully populated.
//
// Everything else (vault enumeration, folder tree, search, rename,
// attachments, AI streaming) needs a non-trivial UUID-vs-path adapter on
// the Rust side before it can be wired here. Until then, calling those
// methods throws a named error that surfaces clearly to the caller.

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

/** Thrown by adapter methods that have not been ported to desktop yet. */
export class TauriAdapterNotImplementedError extends Error {
  readonly method: string

  constructor(method: string) {
    super(`TauriVaultAdapter.${method} is not yet wired in desktop adapter`)
    this.name = 'TauriAdapterNotImplementedError'
    this.method = method
  }
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

async function loadInvoke(): Promise<InvokeFn> {
  // Lazy import so the web build (which aliases @tauri-apps/api to a stub
  // that throws on call) does not break at module-eval time.
  const mod = (await import('@tauri-apps/api/core')) as { invoke: InvokeFn }
  return mod.invoke
}

export class TauriVaultAdapter implements VaultAdapter {
  async listVaults(): Promise<Vault[]> {
    throw new TauriAdapterNotImplementedError('listVaults')
  }

  async getVault(id: string): Promise<Vault> {
    void id
    throw new TauriAdapterNotImplementedError('getVault')
  }

  async listFolders(vaultId: string): Promise<Folder[]> {
    void vaultId
    throw new TauriAdapterNotImplementedError('listFolders')
  }

  async listNotes(
    vaultId: string,
    opts?: { folderId?: string | null; limit?: number; cursor?: string | null },
  ): Promise<Page<NoteSummary>> {
    void vaultId
    void opts
    throw new TauriAdapterNotImplementedError('listNotes')
  }

  async getNote(noteId: string): Promise<Note> {
    const invoke = await loadInvoke()
    const content = await invoke<string>('get_note_content', { path: noteId })
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
    void vaultId
    void body
    throw new TauriAdapterNotImplementedError('createNote')
  }

  async saveNote(noteId: string, body: SaveNoteRequest): Promise<{ version: number }> {
    const invoke = await loadInvoke()
    await invoke<void>('save_note_content', { path: noteId, content: body.bodyMd })
    return { version: body.expectedVersion + 1 }
  }

  async deleteNote(noteId: string): Promise<void> {
    const invoke = await loadInvoke()
    await invoke<void>('delete_note', { path: noteId })
  }

  async rename(vaultId: string, fromPath: string, toPath: string): Promise<RenameResult> {
    // The Rust side has rename_note / rename_note_filename, but the call
    // shape (vault_path, old_path, new_title vs new_filename_stem) does
    // not map cleanly to (fromPath, toPath). Leaving as TODO until the
    // desktop callers move to this adapter.
    void vaultId
    void fromPath
    void toPath
    throw new TauriAdapterNotImplementedError('rename')
  }

  async search(vaultId: string, query: string, mode?: 'full' | 'prefix'): Promise<SearchResponse> {
    void vaultId
    void query
    void mode
    throw new TauriAdapterNotImplementedError('search')
  }

  async uploadAttachment(file: Blob, meta: AttachmentMeta): Promise<Attachment> {
    void file
    void meta
    throw new TauriAdapterNotImplementedError('uploadAttachment')
  }

  async getAttachmentUrl(id: string): Promise<string> {
    void id
    throw new TauriAdapterNotImplementedError('getAttachmentUrl')
  }

  async streamAi(
    req: AiStreamRequest,
    onEvent: (e: AiStreamEvent) => void,
  ): Promise<AbortController> {
    void req
    void onEvent
    throw new TauriAdapterNotImplementedError('streamAi')
  }
}
