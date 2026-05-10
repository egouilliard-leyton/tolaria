// Barrel for the desktop "Sync vault to Tolaria Cloud" feature.
//
// Importers should pull from this module rather than reaching directly into
// individual files; the dialog and hook are the only public surface.

export { SyncToCloudDialog } from './SyncToCloudDialog'
export type { SyncToCloudDialogProps } from './SyncToCloudDialog'
export {
  useSyncToCloud,
  readPersistedCloudSync,
  type SyncableNote,
  type SyncableAttachment,
  type SyncStep,
  type SyncProgress,
  type SyncResult,
  type SyncToCloudConfig,
  type UseSyncToCloudOptions,
} from './useSyncToCloud'
