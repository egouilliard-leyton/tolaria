// Hook orchestrating the desktop -> Tolaria Cloud migration flow.
//
// The hook owns the multi-step state machine (sign-in -> destination ->
// progress) and exposes one method per transition. Each method returns a
// `Result` so the dialog can render success/failure without any throw
// plumbing of its own.
//
// Side effects this hook performs:
//   - Calls `setAccessToken()` from the api-client when the user pastes a
//     JWT.
//   - Reuses the active VaultAdapter (HTTP-backed) for vault listing,
//     creation, folder creation, note POST, and attachment upload.
//   - Persists the resulting `cloudSync` state in localStorage keyed by
//     vault path (no save_vault_settings command exists yet).
//   - Persists a per-vault resume checkpoint in localStorage so a killed
//     sync can resume from after the last completed slug.
//
// What the hook does NOT do:
//   - It never imports `@tauri-apps/api` directly. The desktop-only
//     enumeration of `VaultEntry[]` is supplied by the caller (the
//     SettingsPanel passes it in from `useVaultLoader`'s output).
//   - It does NOT upload backlinks. Backlinks (`note_links` rows) are
//     recomputed server-side by the `index-note` worker once a note
//     lands, so there is no client-side "upload backlinks" step.

import { useCallback, useMemo, useState } from 'react'

import { setAccessToken } from '../../lib/vault-adapter/api-client.js'
import { getActiveVaultAdapter } from '../../lib/vault-adapter/index.js'
import type {
  Attachment,
  AttachmentMeta,
  Folder,
  Note,
  Vault,
  VaultAdapter,
} from '../../lib/vault-adapter/types.js'

export type SyncStep = 'sign-in' | 'destination' | 'progress' | 'complete'

export interface SyncableNote {
  /** Absolute vault path to the note file on disk. */
  path: string
  /** Filename relative to the vault. Used as a fallback title. */
  filename: string
  /** Display title for progress reporting. */
  title: string
  /** Reader for the note's markdown body. The dialog wires this to the
   *  desktop `get_note_content` invoke; tests pass a stub. */
  readBody: () => Promise<string>
  /** Optional explicit frontmatter; when omitted the server parses the body. */
  frontmatter?: Record<string, unknown>
  /** Optional folder hierarchy this note belongs to, expressed as a
   *  posix-style path relative to the vault root (e.g. `projects/2026`).
   *  Empty / undefined means the vault root. If absent we derive the
   *  folder from `path` by stripping the filename. */
  folderPath?: string
}

export interface SyncProgress {
  total: number
  completed: number
  failed: number
  /** Title of the note/folder/attachment currently being uploaded, or
   *  null when idle. */
  current: string | null
  errors: Array<{ note: string; message: string }>
}

export interface SyncResult {
  ok: boolean
  error?: string
}

export interface SyncToCloudConfig {
  enabled: boolean
  subscriptionId?: string
  vaultId?: string
  lastSyncedAt?: number
}

export interface UseSyncToCloudOptions {
  /** Called after a successful sync so the desktop shell can flip the vault
   *  to "synced" mode. Receives the destination vault id and timestamp. */
  onSynced?: (config: SyncToCloudConfig) => void
  /** Optional adapter override (used in tests to inject a stub). */
  adapter?: VaultAdapter
  /** Optional vault-settings persistence override; defaults to
   *  localStorage under the `tolaria.cloudSync.<vaultPath>` key. */
  persistConfig?: (vaultPath: string, config: SyncToCloudConfig) => void
}

const PROGRESS_INITIAL: SyncProgress = {
  total: 0,
  completed: 0,
  failed: 0,
  current: null,
  errors: [],
}

/**
 * Shape of the resume checkpoint persisted to localStorage between
 * partial syncs. Keys are stable identifiers for each work item so we
 * can resume after a closed dialog / killed window without duplicating
 * uploads on retry.
 *
 *   - `completedFolderPaths`: posix paths already created cloud-side
 *   - `completedNotePaths`: the local `SyncableNote.path` values whose
 *     `createNote` POST succeeded
 *   - `completedAttachmentSlugs`: the per-attachment `slug` (path or
 *     unique key) that the caller stamped on `SyncableAttachment`
 */
export type Checkpoint = {
  cloudVaultId: string
  cloudSubscriptionId: string
  completedFolderPaths: string[]
  completedNotePaths: string[]
  completedAttachmentSlugs: string[]
  /** `folderPath → cloud folder id` so a resumed run can bind notes
   *  without recreating the folder hierarchy from scratch. */
  folderIdsByPath: Record<string, string>
  /** `note local path → cloud note id` so a resumed run can bind
   *  attachments to the correct cloud note. */
  noteIdsByPath: Record<string, string>
  lastUpdatedAt: number
}

export function useSyncToCloud(options: UseSyncToCloudOptions = {}) {
  const [step, setStep] = useState<SyncStep>('sign-in')
  const [vaults, setVaults] = useState<Vault[]>([])
  const [destination, setDestination] = useState<Vault | null>(null)
  const [progress, setProgress] = useState<SyncProgress>(PROGRESS_INITIAL)
  const [isBusy, setBusy] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)

  const adapter = useMemo<VaultAdapter>(
    () => options.adapter ?? lazyAdapter(),
    [options.adapter],
  )
  const persist = options.persistConfig ?? defaultPersist

  const submitToken = useCallback(
    async (token: string): Promise<SyncResult> => {
      const trimmed = token.trim()
      if (!trimmed) {
        const error = 'Paste your access token to continue.'
        setSignInError(error)
        return { ok: false, error }
      }
      setBusy(true)
      setSignInError(null)
      try {
        setAccessToken(trimmed)
        const list = await adapter.listVaults()
        setVaults(list)
        setStep('destination')
        return { ok: true }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Sign-in failed.'
        setAccessToken(null)
        setSignInError(message)
        return { ok: false, error: message }
      } finally {
        setBusy(false)
      }
    },
    [adapter],
  )

  const selectExistingVault = useCallback(
    (vault: Vault): SyncResult => {
      setDestination(vault)
      setStep('progress')
      return { ok: true }
    },
    [],
  )

  const createDestinationVault = useCallback(
    async (name: string, slug: string): Promise<SyncResult> => {
      if (!name.trim() || !slug.trim()) {
        return { ok: false, error: 'Name and slug are required.' }
      }
      setBusy(true)
      try {
        const created = await callCreateVault(adapter, name.trim(), slug.trim())
        setVaults((prev) => [...prev, created])
        setDestination(created)
        setStep('progress')
        return { ok: true }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create vault.'
        return { ok: false, error: message }
      } finally {
        setBusy(false)
      }
    },
    [adapter],
  )

  const runSync = useCallback(
    async (
      vaultLocalPath: string,
      notes: SyncableNote[],
      attachments: SyncableAttachment[] = [],
    ): Promise<SyncResult> => {
      if (!destination) return { ok: false, error: 'No destination vault selected.' }
      setBusy(true)

      const checkpoint = loadCheckpoint(vaultLocalPath, destination.id)
      const folderPaths = collectFolderPaths(notes)
      const folderPathsRemaining = folderPaths.filter(
        (path) => !checkpoint.completedFolderPaths.includes(path),
      )
      const notesRemaining = notes.filter(
        (note) => !checkpoint.completedNotePaths.includes(note.path),
      )
      const attachmentsRemaining = attachments.filter(
        (att) => !checkpoint.completedAttachmentSlugs.includes(att.slug),
      )
      const totals =
        folderPathsRemaining.length + notesRemaining.length + attachmentsRemaining.length

      // Pre-seed progress so the dialog can render a meaningful counter
      // even on the resume case where nothing is "currently" running yet.
      setProgress({
        total: totals,
        completed: 0,
        failed: 0,
        current: null,
        errors: [],
      })

      const errors: Array<{ note: string; message: string }> = []
      let completed = 0
      let failed = 0

      // --- 1. Folders ----------------------------------------------------
      for (const folderPath of folderPathsRemaining) {
        setProgress((prev) => ({ ...prev, current: folderPath || '(root)' }))
        try {
          const parentId = parentFolderId(folderPath, checkpoint.folderIdsByPath)
          const created = await callCreateFolder(
            adapter,
            destination.id,
            leafFolderName(folderPath),
            parentId,
          )
          checkpoint.folderIdsByPath[folderPath] = created.id
          checkpoint.completedFolderPaths.push(folderPath)
          persistCheckpoint(vaultLocalPath, checkpoint)
          completed += 1
        } catch (err) {
          failed += 1
          const message = err instanceof Error ? err.message : 'Folder create failed.'
          errors.push({ note: folderPath || '(root)', message })
        }
        setProgress({
          total: totals,
          completed,
          failed,
          current: folderPath || '(root)',
          errors: [...errors],
        })
      }

      // --- 2. Notes ------------------------------------------------------
      for (const note of notesRemaining) {
        setProgress((prev) => ({ ...prev, current: note.title }))
        try {
          const folderPath = noteFolderPath(note)
          const folderId = checkpoint.folderIdsByPath[folderPath] ?? null
          const created = await uploadNote(
            adapter,
            destination.id,
            note,
            folderId,
          )
          checkpoint.noteIdsByPath[note.path] = created.id
          checkpoint.completedNotePaths.push(note.path)
          persistCheckpoint(vaultLocalPath, checkpoint)
          completed += 1
        } catch (err) {
          failed += 1
          const message = err instanceof Error ? err.message : 'Upload failed.'
          errors.push({ note: note.title, message })
        }
        setProgress({
          total: totals,
          completed,
          failed,
          current: note.title,
          errors: [...errors],
        })
      }

      // --- 3. Attachments ------------------------------------------------
      // Attachment loop runs AFTER the notes loop so we can bind each
      // attachment to the cloud note id we just learned. The body of
      // each note still references the local path; once the attachment
      // is uploaded we rewrite the URL in-place via `saveNote`.
      for (const attachment of attachmentsRemaining) {
        setProgress((prev) => ({ ...prev, current: attachment.filename }))
        try {
          const ownerLocalPath = attachment.ownerNotePath ?? null
          const noteId = ownerLocalPath
            ? checkpoint.noteIdsByPath[ownerLocalPath] ?? null
            : null
          const uploaded = await uploadAttachment(
            adapter,
            destination.id,
            attachment,
            noteId,
          )
          if (ownerLocalPath && noteId && attachment.rewriteInBody !== false) {
            await rewriteAttachmentInNoteBody(
              adapter,
              noteId,
              attachment,
              uploaded.url,
            )
          }
          checkpoint.completedAttachmentSlugs.push(attachment.slug)
          persistCheckpoint(vaultLocalPath, checkpoint)
          completed += 1
        } catch (err) {
          failed += 1
          const message = err instanceof Error ? err.message : 'Attachment upload failed.'
          errors.push({ note: attachment.filename, message })
        }
        setProgress({
          total: totals,
          completed,
          failed,
          current: attachment.filename,
          errors: [...errors],
        })
      }

      const config: SyncToCloudConfig = {
        enabled: true,
        vaultId: destination.id,
        lastSyncedAt: Date.now(),
      }
      try {
        persist(vaultLocalPath, config)
        options.onSynced?.(config)
      } catch (err) {
        // Persistence is best-effort; surface but do not abort the sync.
        const message = err instanceof Error ? err.message : 'Could not persist cloudSync settings.'
        errors.push({ note: '(settings)', message })
      }

      // Clear the checkpoint on a fully clean run so the next "sync"
      // is a no-op delta rather than a duplicate pass. We keep it on
      // any failure so the user can retry just the failed slugs.
      if (failed === 0) clearCheckpoint(vaultLocalPath)

      setStep('complete')
      setBusy(false)
      setProgress({
        total: totals,
        completed,
        failed,
        current: null,
        errors: [...errors],
      })
      return failed === 0
        ? { ok: true }
        : { ok: false, error: `${failed} item(s) failed to sync.` }
    },
    [adapter, destination, options, persist],
  )

  const reset = useCallback(() => {
    setStep('sign-in')
    setVaults([])
    setDestination(null)
    setProgress(PROGRESS_INITIAL)
    setBusy(false)
    setSignInError(null)
  }, [])

  return {
    step,
    vaults,
    destination,
    progress,
    isBusy,
    signInError,
    submitToken,
    selectExistingVault,
    createDestinationVault,
    runSync,
    reset,
  }
}

export interface SyncableAttachment {
  /** Stable per-attachment key used for checkpoint dedupe. Typically the
   *  absolute path of the file on disk. */
  slug: string
  filename: string
  blob: Blob
  mime: string
  sha256?: string
  /** Optional explicit note id (cloud-side). Used by callers that already
   *  know the binding. Most callers leave this `null` and instead pass
   *  `ownerNotePath` so the hook can look up the cloud note id after
   *  the note upload pass. */
  noteId?: string | null
  /** Local note path this attachment belongs to. Used to look up the
   *  cloud `noteId` from the in-flight `localPath → cloudNoteId` map
   *  after the note has been uploaded. */
  ownerNotePath?: string | null
  /** Original markdown URL string used inside the owner's body. The
   *  hook rewrites occurrences of this string in the owner note's body
   *  to point at the new cloud-side URL. */
  bodyUrl?: string
  /** When false, suppress in-body URL rewrite. Defaults to true. */
  rewriteInBody?: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function uploadNote(
  adapter: VaultAdapter,
  vaultId: string,
  note: SyncableNote,
  folderId: string | null,
): Promise<Note> {
  const body = await note.readBody()
  return adapter.createNote(vaultId, {
    folderId,
    title: note.title || note.filename || 'Untitled',
    bodyMd: body,
    frontmatter: note.frontmatter ?? {},
  })
}

async function uploadAttachment(
  adapter: VaultAdapter,
  vaultId: string,
  attachment: SyncableAttachment,
  resolvedNoteId: string | null,
): Promise<Attachment> {
  const noteId = attachment.noteId ?? resolvedNoteId ?? null
  const meta: AttachmentMeta & { vaultId: string } = {
    mime: attachment.mime,
    size: attachment.blob.size,
    sha256: attachment.sha256 ?? '',
    filename: attachment.filename,
    noteId,
    // The HTTP adapter requires a `vaultId` on the meta object; tunnel it
    // through (see `vaultIdFromMeta` in http-adapter.ts).
    vaultId,
  }
  return adapter.uploadAttachment(attachment.blob, meta)
}

/**
 * Replace every occurrence of `attachment.bodyUrl` in the note's body
 * with the new cloud-side URL, then push the change via `saveNote`. If
 * the note is missing, no `bodyUrl` was provided, or the adapter does
 * not expose `getNote`, we silently skip — the user-facing failure
 * model is "attachment uploaded; URL still points at local disk."
 */
async function rewriteAttachmentInNoteBody(
  adapter: VaultAdapter,
  noteId: string,
  attachment: SyncableAttachment,
  cloudUrl: string,
): Promise<void> {
  if (!attachment.bodyUrl) return
  try {
    const note = await adapter.getNote(noteId)
    if (!note.bodyMd.includes(attachment.bodyUrl)) return
    const updated = note.bodyMd.split(attachment.bodyUrl).join(cloudUrl)
    await adapter.saveNote(noteId, {
      bodyMd: updated,
      frontmatter: note.frontmatter ?? {},
      expectedVersion: note.version,
    })
  } catch {
    // Rewrites are best-effort. The attachment is already in R2 and
    // the file is recoverable via the cloud UI even if the markdown
    // still points at the original disk path.
  }
}

/**
 * Some VaultAdapter implementations expose `createVault`; others (notably
 * the v1 HTTP adapter at the time of writing) only expose `listVaults` and
 * `getVault`. We probe for it dynamically so the migration tool keeps
 * working as the contract grows.
 *
 * TODO(W2.1): Once `createVault` is part of the `VaultAdapter`
 * interface this probe collapses to a direct call.
 */
async function callCreateVault(
  adapter: VaultAdapter,
  name: string,
  slug: string,
): Promise<Vault> {
  type Maybe = VaultAdapter & {
    createVault?: (input: { name: string; slug: string }) => Promise<Vault>
  }
  const maybe = adapter as Maybe
  if (typeof maybe.createVault === 'function') {
    return maybe.createVault({ name, slug })
  }
  // Fallback: optimistic Vault stub. The next request to listVaults() will
  // refresh this with server data; the test suite covers both paths.
  return {
    id: slug,
    slug,
    name,
    createdAt: new Date().toISOString(),
    settings: {},
  }
}

/**
 * Probes the adapter for `createFolder`. The v1 `VaultAdapter` interface
 * does not require it; the HTTP backend exposes `POST /vaults/:id/folders`
 * and `HttpVaultAdapter` is expected to gain this method shortly. Until
 * then we synthesize an optimistic Folder so the rest of the sync flow
 * keeps working.
 *
 * TODO(W2.1): Move `createFolder` onto the `VaultAdapter` interface and
 * delete this probe.
 */
async function callCreateFolder(
  adapter: VaultAdapter,
  vaultId: string,
  name: string,
  parentId: string | null,
): Promise<Folder> {
  type Maybe = VaultAdapter & {
    createFolder?: (
      vaultId: string,
      input: { name: string; parentId: string | null },
    ) => Promise<Folder>
  }
  const maybe = adapter as Maybe
  if (typeof maybe.createFolder === 'function') {
    return maybe.createFolder(vaultId, { name, parentId })
  }
  // Optimistic stub keyed on the local path so the rest of the sync
  // has a stable id to bind notes to. Real Folder rows have UUID ids;
  // tests cover both code paths.
  const synthetic: Folder = {
    id: `local-folder:${parentId ?? 'root'}/${name}`,
    vaultId,
    parentId,
    name,
    position: 0,
    updatedAt: new Date().toISOString(),
  }
  return synthetic
}

/**
 * Walk the note list and return a deduplicated, top-down sorted list of
 * folder paths. Top-down ordering matters because each folder create
 * needs its parent's cloud id to be already known.
 */
function collectFolderPaths(notes: SyncableNote[]): string[] {
  const seen = new Set<string>()
  for (const note of notes) {
    const path = noteFolderPath(note)
    if (!path) continue
    for (const ancestor of ancestorChain(path)) seen.add(ancestor)
  }
  return [...seen].sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b))
}

function ancestorChain(folderPath: string): string[] {
  const parts = folderPath.split('/').filter(Boolean)
  const chain: string[] = []
  for (let i = 0; i < parts.length; i += 1) {
    chain.push(parts.slice(0, i + 1).join('/'))
  }
  return chain
}

function depthOf(folderPath: string): number {
  if (!folderPath) return 0
  return folderPath.split('/').filter(Boolean).length
}

function parentFolderId(
  folderPath: string,
  folderIdsByPath: Record<string, string>,
): string | null {
  const parts = folderPath.split('/').filter(Boolean)
  if (parts.length <= 1) return null
  const parentPath = parts.slice(0, -1).join('/')
  return folderIdsByPath[parentPath] ?? null
}

function leafFolderName(folderPath: string): string {
  const parts = folderPath.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? folderPath
}

/**
 * Resolve the folder path of a note. The caller-supplied `folderPath`
 * is authoritative; we deliberately do NOT derive a folder from an
 * absolute disk path because the hook has no notion of the vault root
 * and would otherwise materialise the user's home-directory tree as
 * cloud folders. Notes without an explicit `folderPath` land at the
 * vault root cloud-side.
 */
function noteFolderPath(note: SyncableNote): string {
  if (note.folderPath === undefined) return ''
  return normalizeFolderPath(note.folderPath)
}

function normalizeFolderPath(raw: string): string {
  return raw.replace(/\\+/g, '/').replace(/^\/+|\/+$/g, '')
}

// --- Checkpoint persistence -------------------------------------------------

function checkpointKey(vaultPath: string): string {
  return `tolaria.cloudSync.checkpoint.${vaultPath}`
}

function emptyCheckpoint(cloudVaultId: string): Checkpoint {
  return {
    cloudVaultId,
    cloudSubscriptionId: '',
    completedFolderPaths: [],
    completedNotePaths: [],
    completedAttachmentSlugs: [],
    folderIdsByPath: {},
    noteIdsByPath: {},
    lastUpdatedAt: Date.now(),
  }
}

function loadCheckpoint(vaultPath: string, cloudVaultId: string): Checkpoint {
  if (typeof localStorage === 'undefined') return emptyCheckpoint(cloudVaultId)
  const raw = localStorage.getItem(checkpointKey(vaultPath))
  if (!raw) return emptyCheckpoint(cloudVaultId)
  try {
    const parsed = JSON.parse(raw) as Partial<Checkpoint>
    if (parsed.cloudVaultId !== cloudVaultId) {
      // Destination changed since the last attempt; start over.
      return emptyCheckpoint(cloudVaultId)
    }
    return {
      cloudVaultId,
      cloudSubscriptionId: parsed.cloudSubscriptionId ?? '',
      completedFolderPaths: parsed.completedFolderPaths ?? [],
      completedNotePaths: parsed.completedNotePaths ?? [],
      completedAttachmentSlugs: parsed.completedAttachmentSlugs ?? [],
      folderIdsByPath: parsed.folderIdsByPath ?? {},
      noteIdsByPath: parsed.noteIdsByPath ?? {},
      lastUpdatedAt: parsed.lastUpdatedAt ?? Date.now(),
    }
  } catch {
    return emptyCheckpoint(cloudVaultId)
  }
}

function persistCheckpoint(vaultPath: string, checkpoint: Checkpoint): void {
  if (typeof localStorage === 'undefined') return
  const next: Checkpoint = { ...checkpoint, lastUpdatedAt: Date.now() }
  try {
    localStorage.setItem(checkpointKey(vaultPath), JSON.stringify(next))
  } catch {
    // Best-effort persistence; quota errors do not abort the sync.
  }
}

function clearCheckpoint(vaultPath: string): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(checkpointKey(vaultPath))
  } catch {
    // ignore
  }
}

export function readPersistedCheckpoint(vaultPath: string): Checkpoint | null {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(checkpointKey(vaultPath))
  if (!raw) return null
  try {
    return JSON.parse(raw) as Checkpoint
  } catch {
    return null
  }
}

// --- Adapter + cloudSync config persistence --------------------------------

function lazyAdapter(): VaultAdapter {
  return getActiveVaultAdapter()
}

function defaultPersist(vaultPath: string, config: SyncToCloudConfig): void {
  if (typeof localStorage === 'undefined') return
  const key = `tolaria.cloudSync.${vaultPath}`
  localStorage.setItem(key, JSON.stringify(config))
}

export function readPersistedCloudSync(vaultPath: string): SyncToCloudConfig | null {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(`tolaria.cloudSync.${vaultPath}`)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SyncToCloudConfig
  } catch {
    return null
  }
}
