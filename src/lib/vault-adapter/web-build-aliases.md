# Web build Vite aliases

The `pnpm build:web` script (orchestrator scope, not in this PR) produces a
browser-only bundle that must NEVER load `@tauri-apps/api`. The seam is
`HttpVaultAdapter`; everything Tauri-related is shimmed at build time.

This document records the alias config the orchestrator should drop into
`vite.config.ts` (or, more cleanly, a `vite.web.config.ts` extending the
shared one). It is not a runtime artifact — it is a contract between the
adapter and the build.

## Required aliases

```ts
// vite.web.config.ts (orchestrator owns this file)
import { defineConfig, mergeConfig } from 'vite'
import path from 'node:path'
import baseConfig from './vite.config.ts'

export default mergeConfig(
  baseConfig,
  defineConfig({
    define: {
      'import.meta.env.VITE_TARGET': JSON.stringify('web'),
    },
    resolve: {
      alias: [
        // Hard stub — any forgotten desktop-only call surface will throw at
        // runtime instead of silently no-oping.
        {
          find: /^@tauri-apps\/api(\/.*)?$/,
          replacement: path.resolve(__dirname, 'src/lib/vault-adapter/tauri-stub.ts'),
        },
        {
          find: /^@tauri-apps\/plugin-(dialog|opener|process|updater)$/,
          replacement: path.resolve(__dirname, 'src/lib/vault-adapter/tauri-stub.ts'),
        },
      ],
    },
  }),
)
```

The stub itself (also orchestrator scope, but kept tiny so this doc stays
self-contained):

```ts
// src/lib/vault-adapter/tauri-stub.ts
function unavailable(name: string): never {
  throw new Error(
    `[web build] @tauri-apps/${name} is not available. ` +
      'Reach for HttpVaultAdapter via getActiveVaultAdapter() instead.',
  )
}

export const invoke = (...args: unknown[]) => unavailable(`api.invoke(${JSON.stringify(args[0])})`)
export const listen = () => unavailable('api.listen')
export const emit = () => unavailable('api.emit')
export const getCurrentWindow = () => unavailable('api.window')
// …add additional named exports as the build complains about missing ones.
export default new Proxy({}, { get: (_, prop) => unavailable(String(prop)) })
```

## Why a regex match on the alias

`@tauri-apps/api/core`, `@tauri-apps/api/event`, `@tauri-apps/api/path` are
all distinct entry points. The regex above catches every subpath import
with one rule, so we don't have to enumerate them.

## What still ships in the web bundle

- `HttpVaultAdapter` (this directory).
- Everything in `src/components/` that does NOT directly import
  `@tauri-apps/api`. Components that do (e.g. `LinuxTitlebar`) need to be
  guarded with `if (import.meta.env.VITE_TARGET !== 'web')` or moved to
  `src/components/desktop-only/` — that cleanup is orchestrator scope.

## Out of scope for this PR

- `package.json` does not yet have a `build:web` script. The orchestrator
  adds it alongside the alias config above.
- `mock-tauri.ts` is not deleted yet; it is irrelevant to the web build
  once the alias is in place because no component imports it through
  `@tauri-apps/api`.
