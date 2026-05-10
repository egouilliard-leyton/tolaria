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

export function AuthProvider({ apiBaseUrl, fetchImpl, children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [subscription, setSubscription] = useState<AuthSubscription | null>(null)
  const [role, setRole] = useState<AuthRole | null>(null)
  const [isLoading, setIsLoading] = useState(true)

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
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null)
        setSubscription(null)
        setRole(null)
        return
      }
      throw err
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
    })()
    return () => {
      cancelled = true
    }
  }, [refresh])

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
      login,
      logout,
      refresh,
    }),
    [user, subscription, role, isLoading, login, logout, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
