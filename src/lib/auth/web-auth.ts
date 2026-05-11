// SPA-side auth controller for the Tolaria web SaaS build.
//
// Lifecycle:
//   1. App boot -> AuthProvider attempts a silent refresh (via api-client).
//   2. Login button -> startLogin() redirects to /auth/oidc/<provider>/start.
//      The API runs PKCE, completes the OIDC handshake server-side, sets a
//      httpOnly Secure SameSite=Lax refresh cookie, and redirects the
//      browser back to /auth/complete#access_token=…&expires_in=…. The
//      fragment is preferred over the query string because URL fragments
//      are never sent to the server (they don't show up in access logs,
//      Referer headers, or APM traces). For backwards compatibility we
//      also accept the same params on the query string.
//   3. /auth/complete route -> completeLogin() reads the access token from
//      window.location.hash (preferred) or window.location.search, stashes
//      it in memory via api-client.setAccessToken, then uses
//      history.replaceState to scrub the token from the address bar and
//      browser history.
//   4. Subsequent requests -> api-client attaches the access token. On
//      401, it auto-refreshes against POST /auth/refresh (the cookie is
//      sent automatically by the browser).
//   5. Logout -> POST /auth/logout (server clears the refresh cookie),
//      clear in-memory token, redirect to login.
//
// Hard rules (per ADR-0117):
//   - The access token NEVER touches localStorage / sessionStorage / IndexedDB.
//   - The refresh token is httpOnly; JS never sees it.
//   - URL-borne tokens are wiped from `history` on first paint.

import { setAccessToken, getAccessToken } from '../vault-adapter/api-client.js'

export interface LoginCompletion {
  /** The fresh access token, already installed in the api-client. */
  accessToken: string
  /** Unix epoch milliseconds at which this access token expires. */
  expiresAt: number | null
}

/** Redirect to the API's OIDC start endpoint for the given provider. */
export function startLogin(providerId: string = 'default'): void {
  const safeProvider = encodeURIComponent(providerId || 'default')
  if (typeof window === 'undefined') return
  window.location.assign(`/auth/oidc/${safeProvider}/start`)
}

/**
 * Read access_token / expires_in (or expires_at) from the current URL,
 * install the token in memory, and scrub both the fragment and the query
 * string from the browser history.
 *
 * The server delivers the token in the URL fragment (which never reaches
 * server logs / Referer headers). We also fall back to the query string
 * to keep older clients and tests working.
 *
 * Returns the parsed completion when the URL contained a token, or `null`
 * when there was nothing to do (e.g. the route was loaded without a token,
 * which usually means the auth flow failed upstream).
 */
export function completeLogin(): LoginCompletion | null {
  if (typeof window === 'undefined') return null
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const queryParams = new URLSearchParams(window.location.search)
  const accessToken =
    hashParams.get('access_token') ?? queryParams.get('access_token')
  if (!accessToken) return null

  // The server emits `expires_in` (seconds-from-now); the older client wire
  // shape used `expires_at` (unix millis or ISO timestamp). Accept both.
  const expiresInRaw =
    hashParams.get('expires_in') ?? queryParams.get('expires_in')
  const expiresAtRaw =
    hashParams.get('expires_at') ?? queryParams.get('expires_at')
  let expiresAt: number | null = null
  if (expiresInRaw) {
    const seconds = Number(expiresInRaw)
    if (Number.isFinite(seconds) && seconds > 0) {
      expiresAt = Date.now() + seconds * 1000
    }
  } else if (expiresAtRaw) {
    expiresAt = parsePosixOrIsoMillis(expiresAtRaw)
  }

  setAccessToken(accessToken)

  // Scrub both the fragment and the query string so the token does not sit
  // in `window.history`, the page title, or `document.referrer` for any
  // subsequent navigation.
  try {
    window.history.replaceState({}, '', window.location.pathname)
  } catch {
    // some sandboxed environments forbid replaceState; the token is
    // already in memory, the address bar leak is the only consequence.
  }

  return { accessToken, expiresAt }
}

/**
 * Best-effort POST /auth/logout, then clear the in-memory token. Errors
 * are swallowed because we want logout to "always succeed" from the
 * user's perspective even if the network is down.
 */
export async function logout(apiBaseUrl: string): Promise<void> {
  try {
    await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    })
  } catch {
    // ignore — we still nuke the local state below
  }
  setAccessToken(null)
  if (typeof window !== 'undefined') {
    window.location.assign('/login')
  }
}

export { getAccessToken, setAccessToken }

/** Accept either an ISO-8601 timestamp or an epoch-millis number string. */
function parsePosixOrIsoMillis(value: string): number | null {
  const asNumber = Number(value)
  if (Number.isFinite(asNumber) && asNumber > 0) return asNumber
  const asIso = Date.parse(value)
  return Number.isFinite(asIso) ? asIso : null
}
