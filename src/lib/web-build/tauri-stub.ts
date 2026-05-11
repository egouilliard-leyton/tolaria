// Tauri stub for the web build.
//
// Vite aliases every `@tauri-apps/api*` and `@tauri-apps/plugin-*` import in
// the web bundle to this module. The desktop bundle never resolves to this
// file. Each named export below mirrors a symbol that the React tree imports
// somewhere; calling it in the web build throws loudly so a forgotten
// desktop-only call surface fails fast instead of silently no-oping.
//
// The default export is a `Proxy` so unknown member accesses throw too —
// this catches `import * as tauri from '@tauri-apps/api'` style imports
// and dynamic `tauri.foo()` calls without us having to enumerate them.

function unavailable(name: string): never {
  throw new Error(
    `[web build] @tauri-apps stub: ${name} is not available in the web build. ` +
      'Reach for HttpVaultAdapter via getActiveVaultAdapter() or gate the call ' +
      'behind `import.meta.env.VITE_TARGET !== "web"`.',
  )
}

const stubHandler: ProxyHandler<object> = {
  get(_target, prop, _receiver) {
    if (prop === Symbol.toPrimitive || prop === 'then') return undefined
    return () => unavailable(String(prop))
  },
}

const stubProxy = new Proxy({}, stubHandler) as Record<string, unknown>

export default stubProxy

// --- Functions -------------------------------------------------------------

export const invoke = (cmd?: string, ..._rest: unknown[]) =>
  unavailable(`invoke(${cmd ?? '<unknown>'})`)

export const listen = (..._args: unknown[]) => unavailable('listen')
export const once = (..._args: unknown[]) => unavailable('once')
export const emit = (..._args: unknown[]) => unavailable('emit')
export const emitTo = (..._args: unknown[]) => unavailable('emitTo')

export const getCurrentWindow = () => unavailable('getCurrentWindow')
export const getCurrentWebview = () => unavailable('getCurrentWebview')
export const getCurrentWebviewWindow = () => unavailable('getCurrentWebviewWindow')
export const getAllWindows = () => unavailable('getAllWindows')
export const getAllWebviews = () => unavailable('getAllWebviews')

// Window API constructors / classes — the codebase uses them as factory
// imports (`new WebviewWindow(...)`). A constructor proxy keeps the import
// shape valid without needing the real class.
export class Window {
  constructor() {
    unavailable('Window constructor')
  }
}
export class Webview {
  constructor() {
    unavailable('Webview constructor')
  }
}
export class WebviewWindow {
  constructor() {
    unavailable('WebviewWindow constructor')
  }
  static getByLabel = (..._args: unknown[]) => unavailable('WebviewWindow.getByLabel')
  static getAll = () => unavailable('WebviewWindow.getAll')
}

export const PhysicalPosition = function PhysicalPosition() {
  unavailable('PhysicalPosition constructor')
} as unknown as new (...args: unknown[]) => unknown

export const PhysicalSize = function PhysicalSize() {
  unavailable('PhysicalSize constructor')
} as unknown as new (...args: unknown[]) => unknown

export const LogicalPosition = function LogicalPosition() {
  unavailable('LogicalPosition constructor')
} as unknown as new (...args: unknown[]) => unknown

export const LogicalSize = function LogicalSize() {
  unavailable('LogicalSize constructor')
} as unknown as new (...args: unknown[]) => unknown

// Path helpers (`@tauri-apps/api/path`) — promise-returning utilities.
export const appConfigDir = () => Promise.reject(new Error('appConfigDir not available in web build'))
export const appDataDir = () => Promise.reject(new Error('appDataDir not available in web build'))
export const appLocalDataDir = () => Promise.reject(new Error('appLocalDataDir not available in web build'))
export const appLogDir = () => Promise.reject(new Error('appLogDir not available in web build'))
export const homeDir = () => Promise.reject(new Error('homeDir not available in web build'))
export const join = (..._args: unknown[]) => Promise.reject(new Error('join not available in web build'))
export const sep = '/' as const

// Plugin helpers — dialogs, opener, process, updater. These show up via the
// `@tauri-apps/plugin-*` alias bucket.
export const open = (..._args: unknown[]) =>
  Promise.reject(new Error('@tauri-apps plugin: open is not available in web build'))
export const save = (..._args: unknown[]) =>
  Promise.reject(new Error('@tauri-apps plugin: save is not available in web build'))
export const message = (..._args: unknown[]) =>
  Promise.reject(new Error('@tauri-apps plugin: message is not available in web build'))
export const confirm = (..._args: unknown[]) =>
  Promise.reject(new Error('@tauri-apps plugin: confirm is not available in web build'))
export const ask = (..._args: unknown[]) =>
  Promise.reject(new Error('@tauri-apps plugin: ask is not available in web build'))
export const openPath = (..._args: unknown[]) =>
  Promise.reject(new Error('@tauri-apps plugin: openPath is not available in web build'))
export const openUrl = (..._args: unknown[]) =>
  Promise.reject(new Error('@tauri-apps plugin: openUrl is not available in web build'))
export const revealItemInDir = (..._args: unknown[]) =>
  Promise.reject(new Error('@tauri-apps plugin: revealItemInDir is not available in web build'))
export const exit = (..._args: unknown[]) => unavailable('exit')
export const relaunch = () => unavailable('relaunch')
export const check = (..._args: unknown[]) =>
  Promise.reject(new Error('@tauri-apps plugin-updater: check is not available in web build'))

// DPI helpers used by drag/zoom hooks.
export const cursorPosition = () =>
  Promise.reject(new Error('cursorPosition not available in web build'))

// Convert helpers (`@tauri-apps/api/event` exports `convertFileSrc`).
export const convertFileSrc = (path: string) => path

// Tauri's IPC `Channel` is used as `new Channel<T>()`. The web build
// throws if you try to actually send anything through it.
export class Channel<T = unknown> {
  id = -1
  onmessage: ((message: T) => void) | undefined = undefined
  toJSON(): string {
    return '__CHANNEL_STUB__'
  }
}
