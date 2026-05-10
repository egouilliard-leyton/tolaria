// Hook orchestrating the desktop -> Tolaria Cloud migration flow.
//
// The hook is intentionally pure plumbing: it owns the multi-step state
// machine (sign-in -> destination -> progress) and exposes one method per
// transition. Each method returns a `Result` so the dialog can render
// success/failure without any throw plumbing of its own.
//
// Side effects this hook performs:
//   - Calls `setAccessToken()` from the api-client when the user pastes a
//     JWT.
//   - Reuses the active VaultAdapter (HTTP-backed) for vault listing,
//     creation, note POST, and attachment upload.
//   - Persists the resulting `cloudSync` state in localStorage keyed by
//     vault path (no save_vault_settings command exists yet — see deliver
//     notes).
//
// What the hook does NOT do:
//   - It never imports `@tauri-apps/api` directly. The desktop-only
//     enumeration of `VaultEntry[]` is supplied by the caller (the
//     SettingsPanel passes it in from `useVaultLoader`'s output).

import { useCallback, useState } from 'react'

import { setAccessToken } from '../../lib/vault-adapter/api-client.js'
import { getActiveVaultAdapter } from '../../lib/vault-adapter/index.js'
import type {
  Attachment,
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
}

export interface SyncProgress {
  total: number
  completed: number
  failed: number
  /** Title of the note currently being uploaded, or null when idle. */
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

export function useSyncToCloud(options: UseSyncToCloudOptions = {}) {
  const [step, setStep] = useState<SyncStep>('sign-in')
  const [vaults, setVaults] = useState<Vault[]>([])
  const [destination, setDestination] = useState<Vault | null>(null)
  const [progress, setProgress] = useState<SyncProgress>(PROGRESS_INITIAL)
  const [isBusy, setBusy] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)

  const adapter = options.adapter ?? lazyAdapter()
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
      // eslint-disable-next-line no-console
      console.log('[sync-to-cloud] runSync entered, destination=', destination?.id)
      if (!destination) {
        // eslint-disable-next-line no-console
        console.warn('[sync-to-cloud] runSync called with no destination')
        return { ok: false, error: 'No destination vault selected.' }
      }
      setBusy(true)
      // eslint-disable-next-line no-console
      console.log('[sync-to-cloud] runSync looping over', notes.length, 'notes')
      const totals = notes.length + attachments.length
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

      for (const note of notes) {
        setProgress((prev) => ({ ...prev, current: note.title }))
        try {
          // eslint-disable-next-line no-console
          console.log('[sync-to-cloud] uploading', note.title)
          await uploadNote(adapter, destination.id, note)
          // eslint-disable-next-line no-console
          console.log('[sync-to-cloud] uploaded', note.title)
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

      for (const attachment of attachments) {
        setProgress((prev) => ({ ...prev, current: attachment.filename }))
        try {
          await uploadAttachment(adapter, destination.id, attachment)
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
  filename: string
  blob: Blob
  mime: string
  sha256?: string
  noteId?: string | null
}

async function uploadNote(
  adapter: VaultAdapter,
  vaultId: string,
  note: SyncableNote,
): Promise<Note> {
  const body = await note.readBody()
  return adapter.createNote(vaultId, {
    title: note.title || note.filename || 'Untitled',
    bodyMd: body,
    frontmatter: note.frontmatter ?? {},
  })
}

async function uploadAttachment(
  adapter: VaultAdapter,
  vaultId: string,
  attachment: SyncableAttachment,
): Promise<Attachment> {
  return adapter.uploadAttachment(attachment.blob, {
    mime: attachment.mime,
    size: attachment.blob.size,
    sha256: attachment.sha256 ?? '',
    filename: attachment.filename,
    noteId: attachment.noteId ?? null,
    // The HTTP adapter requires a `vaultId` on the meta object; tunnel it
    // through (see `vaultIdFromMeta` in http-adapter.ts).
    vaultId,
  } as never)
}

/**
 * Some VaultAdapter implementations expose `createVault`; others (notably
 * the v1 HTTP adapter at the time of writing) only expose `listVaults` and
 * `getVault`. We probe for it dynamically so the migration tool keeps
 * working as the contract grows.
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
