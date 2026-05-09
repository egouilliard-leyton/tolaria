# `vault-adapter`

The seam between the React UI and whatever backend it is talking to:

- **`tauri-adapter.ts`** (desktop) — calls existing Tauri `invoke()` commands.
- **`http-adapter.ts`** (web) — calls `apps/api` over `fetch` + SSE.

Both implementations satisfy the `VaultAdapter` contract in `types.ts`. The
React app obtains the active adapter via `getActiveVaultAdapter()`; nothing
under `src/` imports `@tauri-apps/api` directly anymore (a Vite alias maps it
to a stub for the web build).

## Boot sequence

```ts
// src/main.tsx
import { setActiveVaultAdapter } from '@/lib/vault-adapter'
import { TauriVaultAdapter } from '@/lib/vault-adapter/tauri-adapter'
import { HttpVaultAdapter } from '@/lib/vault-adapter/http-adapter'

const adapter = import.meta.env.VITE_TARGET === 'web'
  ? new HttpVaultAdapter({ baseUrl: import.meta.env.VITE_API_BASE_URL })
  : new TauriVaultAdapter()

setActiveVaultAdapter(adapter)
```

`VITE_TARGET=web` is set by the `pnpm build:web` script that strips Tauri.

## What does NOT belong here

- Filesystem watchers, OS menus, native dialogs — desktop-only, stay in
  `src/components/desktop-only/` and are conditionally rendered.
- Git status / commit / push — desktop-only.
- CLI agent runtimes (Claude, Codex, Gemini, OpenCode, PI) — server-side AI
  proxy replaces these on web.
