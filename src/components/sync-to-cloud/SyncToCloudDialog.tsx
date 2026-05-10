// "Sync vault to Tolaria Cloud" dialog.
//
// Three steps, driven by `useSyncToCloud()`:
//   1. Sign in. The user opens a browser tab to the API auth flow and
//      pastes the JWT back into a textarea here. We deliberately do NOT
//      ship a full OAuth round-trip on the desktop side — see
//      docs/ARCHITECTURE-WEB-SAAS.md §10 — because the desktop already
//      runs alongside a system browser and pasting the token is the
//      simplest, lowest-trust handshake we can ship in v1.
//   2. Pick the destination vault, or create a new one.
//   3. Iterate over the local notes/attachments, calling the active
//      VaultAdapter for each. Per-item errors are surfaced in the UI but
//      do not abort the sync.
//
// Tauri-only behavior (opening the system browser, reading note bodies)
// is gated behind a `notesProvider` callback the parent supplies. The
// component itself never imports `@tauri-apps/api`, so the web build
// happily tree-shakes the desktop bits.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'

import {
  useSyncToCloud,
  type SyncableAttachment,
  type SyncableNote,
  type SyncToCloudConfig,
  type UseSyncToCloudOptions,
} from './useSyncToCloud'
import type { Vault } from '../../lib/vault-adapter/types.js'

export interface SyncToCloudDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Absolute path of the local vault being migrated. Used as the
   *  persistence key for the cloudSync config. */
  vaultPath: string
  /** Display name of the vault, defaulted as the new cloud vault name. */
  vaultName?: string
  /** Suggested slug for the new cloud vault. */
  vaultSlug?: string
  /** Public URL of the Tolaria Cloud API (no trailing slash). The
   *  in-app sign-in step links to `${apiBaseUrl}/auth/oidc/default/start`. */
  apiBaseUrl: string
  /** Lazy provider for the migrateable note set. Called the first time the
   *  user reaches the progress step. Tests inject a stub. */
  notesProvider: () => Promise<{ notes: SyncableNote[]; attachments?: SyncableAttachment[] }>
  /** Optional handler for opening the API sign-in URL in the system
   *  browser. Defaults to `window.open`; desktop shells override with
   *  `@tauri-apps/plugin-opener`. */
  openSignInUrl?: (url: string) => void | Promise<void>
  /** Forwarded to the hook so consumers can mark the vault as synced. */
  onSynced?: UseSyncToCloudOptions['onSynced']
  /** Test seam: substitute the active vault adapter. */
  adapterOverride?: UseSyncToCloudOptions['adapter']
  /** Test seam: substitute the persistence callback. */
  persistConfig?: UseSyncToCloudOptions['persistConfig']
}

export function SyncToCloudDialog(props: SyncToCloudDialogProps) {
  const {
    open,
    onOpenChange,
    vaultPath,
    vaultName,
    vaultSlug,
    apiBaseUrl,
    notesProvider,
    openSignInUrl,
    onSynced,
    adapterOverride,
    persistConfig,
  } = props

  const sync = useSyncToCloud({
    onSynced,
    adapter: adapterOverride,
    persistConfig,
  })

  // Reset the wizard whenever the dialog is reopened so the user does not
  // accidentally see stale progress from a prior session.
  useEffect(() => {
    if (!open) sync.reset()
    // We intentionally only react to `open` toggles. `sync.reset` is
    // referentially stable courtesy of useCallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        data-testid="sync-to-cloud-dialog"
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>Sync vault to Tolaria Cloud</DialogTitle>
          <DialogDescription>
            Mirror this vault to the hosted backend. The local copy stays on disk; cloud writes
            become canonical once sync completes.
          </DialogDescription>
        </DialogHeader>

        {sync.step === 'sign-in' && (
          <SignInStep
            apiBaseUrl={apiBaseUrl}
            isBusy={sync.isBusy}
            error={sync.signInError}
            onSubmitToken={(token) => void sync.submitToken(token)}
            openSignInUrl={openSignInUrl}
          />
        )}

        {sync.step === 'destination' && (
          <DestinationStep
            vaults={sync.vaults}
            isBusy={sync.isBusy}
            defaultName={vaultName ?? ''}
            defaultSlug={vaultSlug ?? ''}
            onSelect={(vault) => sync.selectExistingVault(vault)}
            onCreate={(name, slug) => void sync.createDestinationVault(name, slug)}
          />
        )}

        {sync.step === 'progress' && (
          <ProgressStep
            vaultPath={vaultPath}
            notesProvider={notesProvider}
            runSync={sync.runSync}
            progress={sync.progress}
          />
        )}

        {sync.step === 'complete' && (
          <CompleteStep
            progress={sync.progress}
            destinationName={sync.destination?.name ?? ''}
            onClose={() => onOpenChange(false)}
          />
        )}

        {sync.step !== 'complete' && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} type="button">
              Cancel
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

// --- Step 1: sign in ----------------------------------------------------

interface SignInStepProps {
  apiBaseUrl: string
  isBusy: boolean
  error: string | null
  onSubmitToken: (token: string) => void
  openSignInUrl?: (url: string) => void | Promise<void>
}

function SignInStep({ apiBaseUrl, isBusy, error, onSubmitToken, openSignInUrl }: SignInStepProps) {
  const [token, setToken] = useState('')
  const signInUrl = useMemo(
    () => `${apiBaseUrl.replace(/\/+$/, '')}/auth/oidc/default/start?return_to=tolaria-desktop://auth-complete`,
    [apiBaseUrl],
  )

  const handleOpen = useCallback(() => {
    if (openSignInUrl) {
      void openSignInUrl(signInUrl)
      return
    }
    if (typeof window !== 'undefined') window.open(signInUrl, '_blank', 'noopener,noreferrer')
  }, [openSignInUrl, signInUrl])

  return (
    <div className="flex flex-col gap-3" data-testid="sync-step-sign-in">
      <p className="text-sm text-muted-foreground">
        Sign in to Tolaria Cloud, then paste the access token from the success page below.
      </p>
      <Button type="button" variant="outline" onClick={handleOpen} data-testid="sync-open-browser">
        Open Tolaria Cloud sign-in
      </Button>
      <Textarea
        data-testid="sync-token-input"
        placeholder="Paste your access token (JWT) here"
        value={token}
        onChange={(event) => setToken(event.currentTarget.value)}
        rows={4}
        className="font-mono text-xs"
        aria-label="Access token"
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive" data-testid="sync-sign-in-error">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button
          type="button"
          onClick={() => onSubmitToken(token)}
          disabled={isBusy || token.trim().length === 0}
          data-testid="sync-submit-token"
        >
          {isBusy ? 'Verifying…' : 'Continue'}
        </Button>
      </div>
    </div>
  )
}

// --- Step 2: pick destination -------------------------------------------

interface DestinationStepProps {
  vaults: Vault[]
  isBusy: boolean
  defaultName: string
  defaultSlug: string
  onSelect: (vault: Vault) => void
  onCreate: (name: string, slug: string) => void
}

function DestinationStep({
  vaults,
  isBusy,
  defaultName,
  defaultSlug,
  onSelect,
  onCreate,
}: DestinationStepProps) {
  const [showCreate, setShowCreate] = useState(vaults.length === 0)
  const [name, setName] = useState(defaultName)
  const [slug, setSlug] = useState(defaultSlug || slugify(defaultName))

  return (
    <div className="flex flex-col gap-3" data-testid="sync-step-destination">
      {!showCreate && vaults.length > 0 && (
        <>
          <p className="text-sm text-muted-foreground">
            Pick the cloud vault that will receive these notes.
          </p>
          <ul className="flex flex-col gap-1" data-testid="sync-vault-list">
            {vaults.map((vault) => (
              <li key={vault.id}>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start"
                  onClick={() => onSelect(vault)}
                  data-testid={`sync-vault-option-${vault.id}`}
                >
                  <span className="font-medium">{vault.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">/{vault.slug}</span>
                </Button>
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowCreate(true)}
            data-testid="sync-show-create"
          >
            Create new vault
          </Button>
        </>
      )}

      {showCreate && (
        <div className="flex flex-col gap-2" data-testid="sync-create-vault-form">
          <label className="text-sm font-medium" htmlFor="sync-new-vault-name">
            Name
          </label>
          <Input
            id="sync-new-vault-name"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            data-testid="sync-new-vault-name"
          />
          <label className="text-sm font-medium" htmlFor="sync-new-vault-slug">
            Slug
          </label>
          <Input
            id="sync-new-vault-slug"
            value={slug}
            onChange={(event) => setSlug(event.currentTarget.value)}
            data-testid="sync-new-vault-slug"
          />
          <div className="flex items-center justify-between">
            {vaults.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setShowCreate(false)}
                data-testid="sync-back-to-list"
              >
                Pick existing vault
              </Button>
            ) : (
              <span />
            )}
            <Button
              type="button"
              onClick={() => onCreate(name, slug)}
              disabled={isBusy || !name.trim() || !slug.trim()}
              data-testid="sync-create-vault"
            >
              {isBusy ? 'Creating…' : 'Create and sync'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// --- Step 3: sync progress ----------------------------------------------

interface ProgressStepProps {
  vaultPath: string
  notesProvider: SyncToCloudDialogProps['notesProvider']
  runSync: ReturnType<typeof useSyncToCloud>['runSync']
  progress: ReturnType<typeof useSyncToCloud>['progress']
}

function ProgressStep({ vaultPath, notesProvider, runSync, progress }: ProgressStepProps) {
  // `useRef` guards against React StrictMode's intentional double-mount in
  // dev. Without it, the cleanup of the first effect would mark the async
  // chain as cancelled and we'd never reach the runSync call on the second
  // mount (the providers are typically vi.fn() shared across both mounts).
  const startedRef = useRef(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void (async () => {
      try {
        const { notes, attachments } = await notesProvider()
        const result = await runSync(vaultPath, notes, attachments ?? [])
        if (!result.ok && result.error) {
          // Errors mid-sync are recorded in `progress.errors` already; the
          // top-level message goes to a separate region for visibility.
          setLoadError(result.error)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not load notes.'
        setLoadError(message)
      }
    })()
    // notesProvider/runSync are stable enough — gate on `startedRef` to run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const percent = progress.total === 0 ? 0 : Math.round((progress.completed / progress.total) * 100)

  return (
    <div className="flex flex-col gap-3" data-testid="sync-step-progress">
      {loadError ? (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      ) : null}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-sm">
          <span data-testid="sync-progress-label">
            {progress.current ?? 'Preparing…'}
          </span>
          <span data-testid="sync-progress-counter">
            {progress.completed}/{progress.total}
          </span>
        </div>
        <div
          className="h-2 w-full rounded bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            data-testid="sync-progress-bar"
            className="h-full rounded bg-primary transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
      {progress.errors.length > 0 ? (
        <ul className="max-h-32 overflow-auto text-xs text-destructive" data-testid="sync-error-list">
          {progress.errors.map((error, index) => (
            <li key={`${error.note}-${index}`}>
              <span className="font-medium">{error.note}:</span> {error.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

// --- Step 4: complete ---------------------------------------------------

interface CompleteStepProps {
  progress: ReturnType<typeof useSyncToCloud>['progress']
  destinationName: string
  onClose: () => void
}

function CompleteStep({ progress, destinationName, onClose }: CompleteStepProps) {
  const failed = progress.failed
  const succeeded = progress.completed
  return (
    <div className="flex flex-col gap-3" data-testid="sync-step-complete">
      <p className="text-sm">
        Synced {succeeded} item(s) to <span className="font-medium">{destinationName}</span>.
        {failed > 0 ? ` ${failed} item(s) failed.` : ''}
      </p>
      {progress.errors.length > 0 ? (
        <ul className="max-h-32 overflow-auto text-xs text-destructive">
          {progress.errors.map((error, index) => (
            <li key={`${error.note}-${index}`}>
              <span className="font-medium">{error.note}:</span> {error.message}
            </li>
          ))}
        </ul>
      ) : null}
      <DialogFooter>
        <Button type="button" onClick={onClose} data-testid="sync-close-complete">
          Done
        </Button>
      </DialogFooter>
    </div>
  )
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export type { SyncToCloudConfig }
