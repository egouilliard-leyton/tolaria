// Settings panel "Cloud" section.
//
// This component is the canonical entry point for the desktop migration
// flow: it renders a small section with a "Sync to Tolaria Cloud" button
// and owns the lifecycle of the SyncToCloudDialog. The notes provider
// callback is supplied by the caller — the desktop shell wires it to
// `useVaultLoader()`'s output and the existing `get_note_content` invoke,
// which keeps this component free of any direct Tauri imports.

import { useCallback, useState } from 'react'

import { Button } from '../ui/button'

import { SyncToCloudDialog } from './SyncToCloudDialog'
import type { SyncableAttachment, SyncableNote, SyncToCloudConfig } from './useSyncToCloud'

export interface CloudSyncSettingsSectionProps {
  vaultPath: string
  vaultName?: string
  vaultSlug?: string
  apiBaseUrl: string
  notesProvider: () => Promise<{ notes: SyncableNote[]; attachments?: SyncableAttachment[] }>
  /** Optional. When provided, the section calls it after a successful
   *  sync so the rest of the app can flip to "synced" mode. */
  onSynced?: (config: SyncToCloudConfig) => void
  /** Optional override; defaults to `window.open`. The desktop shell
   *  wires this to `@tauri-apps/plugin-opener.openUrl`. */
  openSignInUrl?: (url: string) => void | Promise<void>
}

export function CloudSyncSettingsSection(props: CloudSyncSettingsSectionProps) {
  const { vaultPath, vaultName, vaultSlug, apiBaseUrl, notesProvider, onSynced, openSignInUrl } = props
  const [open, setOpen] = useState(false)

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next)
  }, [])

  return (
    <section className="mt-6 space-y-3" data-testid="settings-section-cloud-sync">
      <header className="space-y-1">
        <h3 className="text-base font-semibold">Cloud</h3>
        <p className="text-sm text-muted-foreground">
          Mirror this vault to Tolaria Cloud. The local copy stays on disk; cloud writes become
          canonical once sync completes.
        </p>
      </header>
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        data-testid="open-sync-to-cloud"
      >
        Sync vault to Tolaria Cloud…
      </Button>
      {open ? (
        <SyncToCloudDialog
          open={open}
          onOpenChange={handleOpenChange}
          vaultPath={vaultPath}
          vaultName={vaultName}
          vaultSlug={vaultSlug}
          apiBaseUrl={apiBaseUrl}
          notesProvider={notesProvider}
          onSynced={onSynced}
          openSignInUrl={openSignInUrl}
        />
      ) : null}
    </section>
  )
}
