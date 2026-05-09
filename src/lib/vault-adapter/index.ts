// Active VaultAdapter selection.
//
// The desktop build reaches in through tauri-adapter (kept thin: the existing
// invoke() call sites still work directly today, and this seam exists so
// React can be made backend-agnostic over time).
//
// The web build uses http-adapter and never imports @tauri-apps/api.
//
// Selection happens once at module load. Both adapters are tree-shakeable in
// their respective Vite configs so the wrong one is not bundled.

import type { VaultAdapter } from './types.js'

let activeAdapter: VaultAdapter | null = null

export function setActiveVaultAdapter(adapter: VaultAdapter): void {
  activeAdapter = adapter
}

export function getActiveVaultAdapter(): VaultAdapter {
  if (!activeAdapter) {
    throw new Error(
      'No VaultAdapter has been registered. ' +
        'Call setActiveVaultAdapter() at app boot (see src/lib/vault-adapter/README.md).',
    )
  }
  return activeAdapter
}

export type * from './types.js'
