// React context that exposes auth state to the whole web app.
//
// On mount it kicks off a silent refresh (POST /auth/refresh), and if that
// succeeds it fetches /me and supplies { user, subscription, role }. The
// `useAuth()` hook is the only sanctioned way for components to read auth
// state — components must not poke at cookies or in-memory tokens
// directly.
//
// While the initial refresh is in flight, `isAuthenticated` is `false`
// and `isLoading` is `true`. UI components should render a neutral
// loading state until `isLoading` resolves.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { ApiClient, ApiError, setAccessToken } from '../vault-adapter/api-client.js'
import { getActiveVaultAdapter } from '../vault-adapter/index.js'
import {
  AuthContext,
  type AuthRole,
  type AuthState,
  type AuthSubscription,
  type AuthUser,
} from './auth-context.js'
import { logout as performLogout, startLogin } from './web-auth.js'

interface MeResponse {
  user: { id: string; email: string; name?: string; avatar_url?: string }
  subscription: { id: string; name: string; plan: string }
  role: AuthRole
}

export interface AuthProviderProps {
  apiBaseUrl: string
  /** Override for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  children: ReactNode
}

/**
 * `ApiError` codes / statuses that indicate the API is unreachable rather
 * than a logical failure. Status `0` is the canonical "fetch threw before
 * receiving a response" signal (DNS, offline, CORS preflight failure); the
 * `network_unavailable` code is the named alias for the same condition.
 *
 * Why we treat `status === 0` as unreachable: when `fetch()` rejects (no
 * response was received), the API client surfaces the rejection as an
 * `ApiError` with `status === 0`. Any non-zero status means we got a
 * response back, which by definition means the cloud is reachable.
 */
function isNetworkUnavailable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false
  return err.code === 'network_unavailable' || err.status === 0
}

export function AuthProvider({ apiBaseUrl, fetchImpl, children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [subscription, setSubscription] = useState<AuthSubscription | null>(null)
  const [role, setRole] = useState<AuthRole | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [cloudReachable, setCloudReachable] = useState<boolean | null>(null)

  const clientRef = useRef<ApiClient | null>(null)
  if (!clientRef.current) {
    clientRef.current = new ApiClient({
      baseUrl: apiBaseUrl,
      fetchImpl,
      onAuthError: () => {
        // Refresh attempt failed — clear local state so any UI guarded by
        // `isAuthenticated` falls back to the login surface.
        setAccessToken(null)
        setUser(null)
        setSubscription(null)
        setRole(null)
      },
    })
  }

  const refresh = useCallback(async () => {
    const client = clientRef.current
    if (!client) return
    try {
      const me = await client.getJson<MeResponse>('/me')
      setUser({
        id: me.user.id,
        email: me.user.email,
        name: me.user.name,
        avatarUrl: me.user.avatar_url,
      })
      setSubscription({ id: me.subscription.id, name: me.subscription.name, plan: me.subscription.plan })
      setRole(me.role)
      // Any successful response — including 401, which we catch below — means
      // the cloud is reachable; only fetch-level failures flip the flag off.
      setCloudReachable(true)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null)
        setSubscription(null)
        setRole(null)
        setCloudReachable(true)
        return
      }
      if (isNetworkUnavailable(err)) {
        setCloudReachable(false)
        return
      }
      throw err
    }
  }, [])

  // Probe the cloud once at boot via the active vault adapter. The
  // `getActiveVaultAdapter().listVaults()` call exercises the same HTTP path
  // the rest of the app uses, so a fetch-level failure here (offline, DNS,
  // CORS preflight) is the canonical signal that the cloud is unreachable.
  // We swallow non-network errors: a 401 / 403 still means the API itself
  // answered, and `refresh()` will surface the auth state separately.
  const probeReachability = useCallback(async () => {
    try {
      await getActiveVaultAdapter().listVaults()
      setCloudReachable(true)
    } catch (err) {
      if (isNetworkUnavailable(err)) {
        setCloudReachable(false)
        return
      }
      // Any other error means the API answered, so the cloud is reachable.
      setCloudReachable(true)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await refresh()
      } finally {
        if (!cancelled) setIsLoading(false)
      }
      // The probe runs after `refresh()` so an authenticated session can
      // exercise the real `/vaults` endpoint; if the user isn't signed in
      // yet, the adapter call still surfaces a network-level failure.
      if (!cancelled) await probeReachability()
    })()
    return () => {
      cancelled = true
    }
  }, [refresh, probeReachability])

  const login = useCallback((providerId?: string) => {
    startLogin(providerId ?? 'default')
  }, [])

  const logout = useCallback(async () => {
    await performLogout(apiBaseUrl)
    setUser(null)
    setSubscription(null)
    setRole(null)
  }, [apiBaseUrl])

  const value = useMemo<AuthState>(
    () => ({
      user,
      subscription,
      role,
      isAuthenticated: user !== null,
      isLoading,
      cloudReachable,
      login,
      logout,
      refresh,
    }),
    [user, subscription, role, isLoading, cloudReachable, login, logout, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
