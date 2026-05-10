// SPA-side auth controller for the Tolaria web SaaS build.
//
// Lifecycle:
//   1. App boot -> AuthProvider attempts a silent refresh (via api-client).
//   2. Login button -> startLogin() redirects to /auth/oidc/<provider>/start.
//      The API runs PKCE, completes the OIDC handshake server-side, sets a
//      httpOnly Secure SameSite=Lax refresh cookie, and redirects the
//      browser back to /auth/complete?access_token=…&expires_at=….
//   3. /auth/complete route -> completeLogin() reads the access token from
//      the URL, stashes it in memory via api-client.setAccessToken, then
//      uses history.replaceState to scrub the token from the address bar
//      and browser history.
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
 * Read access_token / expires_at from the current URL, install the token
 * in memory, and scrub the query string from the browser history.
 *
 * Returns the parsed completion when the URL contained a token, or `null`
 * when there was nothing to do (e.g. the route was loaded without a token,
 * which usually means the auth flow failed upstream).
 */
export function completeLogin(): LoginCompletion | null {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const accessToken = url.searchParams.get('access_token')
  if (!accessToken) return null

  const expiresAtRaw = url.searchParams.get('expires_at')
  const expiresAt = expiresAtRaw ? parsePosixOrIsoMillis(expiresAtRaw) : null

  setAccessToken(accessToken)

  // Scrub the URL so the token doesn't sit in `window.history`, the page
  // title, or `document.referrer` for any subsequent navigation.
  url.searchParams.delete('access_token')
  url.searchParams.delete('expires_at')
  const cleaned = `${url.pathname}${url.search ? url.search : ''}${url.hash}`
  try {
    window.history.replaceState({}, '', cleaned)
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
