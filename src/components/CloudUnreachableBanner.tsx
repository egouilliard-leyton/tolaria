import { useContext } from 'react'
import { AuthContext } from '../lib/auth/auth-context.js'

// Thin top-of-page banner shown in the web build when the SaaS API is
// unreachable. The AuthProvider drives `cloudReachable` to `false` when
// the boot-time `getActiveVaultAdapter().listVaults()` probe throws an
// `ApiError` whose code is `network_unavailable` or whose status is 0
// (see G73 in docs/web-saas/verification-final-2026-05-11.md).
//
// We read from `AuthContext` directly rather than calling `useAuth()`
// because `useAuth()` throws when called outside an `AuthProvider`. The
// desktop build mounts `<App />` without a provider — there the banner
// short-circuits to `null` and renders nothing.
//
// The string is inlined here on purpose: the locale file is small and
// every other string in the codebase is keyed by feature, so adding a
// banner string to the cloud namespace would create a `cloud.*` group
// for a single key. If the SaaS surface grows more user-facing copy we
// should move this into `src/lib/locales/en.json` and run
// `pnpm l10n:translate`.
export function CloudUnreachableBanner(): JSX.Element | null {
  const auth = useContext(AuthContext)
  if (!auth) return null
  if (auth.cloudReachable !== false) return null

  return (
    <div
      role="alert"
      className="bg-amber-100 text-amber-900 px-4 py-2 text-sm"
    >
      Tolaria Cloud is unreachable. Recent edits will retry once
      connectivity returns.
    </div>
  )
}
