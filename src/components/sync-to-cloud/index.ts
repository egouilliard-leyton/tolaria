// Barrel for the desktop "Sync vault to Tolaria Cloud" feature.
//
// Importers should pull from this module rather than reaching directly into
// individual files; the dialog, the hook, and the settings-section trigger
// are the public surface.

export { SyncToCloudDialog } from './SyncToCloudDialog'
export type { SyncToCloudDialogProps } from './SyncToCloudDialog'
export {
  CloudSyncSettingsSection,
  type CloudSyncSettingsSectionProps,
} from './CloudSyncSettingsSection'
export {
  useSyncToCloud,
  readPersistedCloudSync,
  readPersistedCheckpoint,
  type Checkpoint,
  type SyncableNote,
  type SyncableAttachment,
  type SyncStep,
  type SyncProgress,
  type SyncResult,
  type SyncToCloudConfig,
  type UseSyncToCloudOptions,
} from './useSyncToCloud'
