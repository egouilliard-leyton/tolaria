import { StrictMode, type ReactNode } from 'react'
import * as Sentry from '@sentry/react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import './index.css'
import App from './App.tsx'
import { FrontendReadyMarker } from './components/FrontendReadyMarker'
import { LinuxTitlebar } from './components/LinuxTitlebar'
import { applyStoredThemeMode } from './lib/themeMode'
import { setActiveVaultAdapter } from './lib/vault-adapter'
import {
  APP_COMMAND_EVENT_NAME,
  isAppCommandId,
  isNativeMenuCommandId,
} from './hooks/appCommandDispatcher'
import {
  getShortcutEventInit,
  type AppCommandShortcutEventInit,
  type AppCommandShortcutEventOptions,
} from './hooks/appCommandCatalog'
import { isRecoveredBlockNoteRenderError } from './components/blockNoteRenderRecovery'
import { shouldUseLinuxWindowChrome } from './utils/platform'
import { reloadFrontendOnceIfStartupFailed } from './utils/frontendReady'

const EDITOR_DROP_SELECTOR = '.editor__blocknote-container'
const TLDRAW_CONTEXT_MENU_SELECTOR = '.tldraw-whiteboard'

function dataTransferHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  if (dataTransfer.files.length > 0) return true
  if (Array.from(dataTransfer.types).includes('Files')) return true

  return Array.from(dataTransfer.items).some((item) => item.kind === 'file')
}

function isEditorDropTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(EDITOR_DROP_SELECTOR) !== null
}

function preventFileDropNavigation(event: DragEvent): void {
  if (isEditorDropTarget(event.target)) return
  if (!dataTransferHasFiles(event.dataTransfer)) return

  event.preventDefault()
}

function isTldrawContextMenuTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TLDRAW_CONTEXT_MENU_SELECTOR) !== null
}

function preventNativeContextMenu(event: MouseEvent): void {
  if (isTldrawContextMenuTarget(event.target)) return

  event.preventDefault()
}

document.addEventListener('dragover', preventFileDropNavigation, true)
document.addEventListener('drop', preventFileDropNavigation, true)

// Disable native WebKit context menu in Tauri (WKWebView intercepts right-click
// at native level before React's synthetic events can call preventDefault).
// Capture phase fires first → prevents native menu; React bubble phase still fires
// → our custom context menus (e.g. sidebar right-click) work correctly.
if ('__TAURI__' in window || '__TAURI_INTERNALS__' in window) {
  document.addEventListener('contextmenu', preventNativeContextMenu, true)
}

if (shouldUseLinuxWindowChrome()) {
  document.body.classList.add('linux-chrome')
}

applyStoredThemeMode(document, window.localStorage)

function dispatchDeterministicShortcutEvent(init: AppCommandShortcutEventInit) {
  const target =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : document.body ?? window

  target.dispatchEvent(new KeyboardEvent('keydown', init))
}

window.__laputaTest = {
  dispatchAppCommand(id: string) {
    if (!isAppCommandId(id)) {
      throw new Error(`Unknown app command: ${id}`)
    }
    window.dispatchEvent(new CustomEvent(APP_COMMAND_EVENT_NAME, { detail: id }))
  },
  dispatchShortcutEvent(init: AppCommandShortcutEventInit) {
    dispatchDeterministicShortcutEvent(init)
  },
  async triggerMenuCommand(id: string) {
    if (!isNativeMenuCommandId(id)) {
      throw new Error(`Unknown native menu command: ${id}`)
    }

    if ('__TAURI__' in window || '__TAURI_INTERNALS__' in window) {
      const { invoke } = await import('@tauri-apps/api/core')
      return invoke('trigger_menu_command', { id })
    }

    if (!window.__laputaTest?.dispatchBrowserMenuCommand) {
      throw new Error('Tolaria test bridge is missing dispatchBrowserMenuCommand')
    }

    window.__laputaTest.dispatchBrowserMenuCommand(id)
    return undefined
  },
  triggerShortcutCommand(id: string, options?: AppCommandShortcutEventOptions) {
    if (!isAppCommandId(id)) {
      throw new Error(`Unknown app command: ${id}`)
    }

    const init = getShortcutEventInit(id, options)
    if (!init) {
      throw new Error(`Command ${id} does not define a keyboard shortcut`)
    }

    dispatchDeterministicShortcutEvent(init)
  },
}

const sentryReactErrorHandler = Sentry.reactErrorHandler()

function captureReactRootError(
  error: unknown,
  errorInfo: { componentStack?: string },
): void {
  const componentStack = errorInfo.componentStack ?? ''
  sentryReactErrorHandler(error, { componentStack })
  reloadFrontendOnceIfStartupFailed()
}

function captureRecoverableReactRootError(
  error: unknown,
  errorInfo: { componentStack?: string },
): void {
  const componentStack = errorInfo.componentStack ?? ''
  if (isRecoveredBlockNoteRenderError(error, componentStack)) return

  captureReactRootError(error, { componentStack })
}

// Boot order: pick the right VaultAdapter for the build target *before*
// React renders, then mount the tree. The web build also wraps `<App />`
// in `<AuthProvider />` so silent refresh and the auth gate work; the
// desktop build keeps the existing render shape (no provider).
//
// `WEB_SAAS_ENABLED` is a build-time global defined in `vite.config.ts`.
// It defaults to `true` in the web build so a shipped bundle is live by
// default, but a deployment can override it with `WEB_SAAS_ENABLED=false`
// at build time to ship the bundle in a "coming soon" state. The desktop
// build ignores the flag entirely.
async function bootstrap(): Promise<void> {
  let withAuthProvider: (node: ReactNode) => ReactNode = (node) => node

  if (import.meta.env.VITE_TARGET === 'web') {
    if (import.meta.env.WEB_SAAS_ENABLED !== true) {
      renderFeatureDisabledSplash()
      return
    }

    const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/'
    const { HttpVaultAdapter } = await import('./lib/vault-adapter/http-adapter')
    setActiveVaultAdapter(new HttpVaultAdapter({ baseUrl: apiBaseUrl }))

    const { AuthProvider } = await import('./lib/auth/AuthProvider')
    withAuthProvider = (node) => <AuthProvider apiBaseUrl={apiBaseUrl}>{node}</AuthProvider>
  } else {
    // Desktop boot. If the active vault has been flipped to "synced" mode
    // (via Settings → Cloud), use the HTTP adapter and the AuthProvider so
    // reads/writes flow through the SaaS API instead of the local Rust
    // filesystem commands. Fall back to TauriVaultAdapter on any error or
    // when cloudSync is disabled.
    const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/'
    const activeVaultPath = await readActiveVaultPath()
    const cloudSync = activeVaultPath ? readPersistedCloudSync(activeVaultPath) : null
    const useHttp = cloudSync?.enabled === true

    if (useHttp) {
      const { HttpVaultAdapter } = await import('./lib/vault-adapter/http-adapter')
      setActiveVaultAdapter(new HttpVaultAdapter({ baseUrl: apiBaseUrl }))
      const { AuthProvider } = await import('./lib/auth/AuthProvider')
      withAuthProvider = (node) => <AuthProvider apiBaseUrl={apiBaseUrl}>{node}</AuthProvider>
    } else {
      const { TauriVaultAdapter } = await import('./lib/vault-adapter/tauri-adapter')
      setActiveVaultAdapter(new TauriVaultAdapter())
    }
  }

  createRoot(document.getElementById('root')!, {
    onCaughtError: captureRecoverableReactRootError,
    onUncaughtError: captureReactRootError,
    onRecoverableError: captureRecoverableReactRootError,
  }).render(
    <StrictMode>
      <TooltipProvider>
        <LinuxTitlebar />
        {withAuthProvider(<App />)}
        <FrontendReadyMarker />
      </TooltipProvider>
    </StrictMode>,
  )
}

// Read the active vault path from the desktop's vault list. We tolerate
// failures (the Tauri command may not be available in the test
// environment) by returning null, in which case the boot falls through to
// the Tauri adapter. The returned path is the key under which the
// Sync-to-Cloud dialog persisted the `cloudSync` config in localStorage
// (see `src/components/sync-to-cloud/useSyncToCloud.ts:342-357`).
async function readActiveVaultPath(): Promise<string | null> {
  try {
    const mod = (await import('@tauri-apps/api/core')) as {
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
    }
    interface VaultListDto {
      vaults?: Array<{ path: string }>
      active_vault?: string | null
    }
    const list = await mod.invoke<VaultListDto>('load_vault_list', {})
    if (list.active_vault) return list.active_vault
    return list.vaults?.[0]?.path ?? null
  } catch {
    return null
  }
}

interface PersistedCloudSync {
  enabled: boolean
  vaultId?: string
  subscriptionId?: string
  lastSyncedAt?: number
}

function readPersistedCloudSync(vaultPath: string): PersistedCloudSync | null {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(`tolaria.cloudSync.${vaultPath}`)
  if (!raw) return null
  try {
    return JSON.parse(raw) as PersistedCloudSync
  } catch {
    return null
  }
}

// Minimal pre-React splash for the "WEB_SAAS_ENABLED is false" case so a
// deployment can ship the bundle with the feature dark. We avoid the
// React tree on purpose: the adapter is never wired in this mode, so
// `<App />` would crash on the first `getActiveVaultAdapter()` call.
function renderFeatureDisabledSplash(): void {
  const root = document.getElementById('root')
  if (!root) return
  root.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,-apple-system,sans-serif;color:#475569;background:#f8fafc;">
      <div style="max-width:420px;padding:32px;text-align:center;">
        <h1 style="font-size:18px;font-weight:600;margin:0 0 8px 0;color:#0f172a;">Tolaria for the web is coming soon</h1>
        <p style="font-size:14px;line-height:1.5;margin:0;">
          This deployment ships with the SaaS surface disabled. Set
          <code style="background:#e2e8f0;padding:2px 6px;border-radius:4px;font-size:12px;">WEB_SAAS_ENABLED=true</code>
          at build time to enable it.
        </p>
      </div>
    </div>
  `
}

void bootstrap()
