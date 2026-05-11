// Shared React context for the auth state. Lives in its own module so the
// component file (AuthProvider.tsx) only exports a component — the
// react-refresh/only-export-components rule fires when a *.tsx file mixes
// component and non-component exports.

import { createContext } from 'react'

export interface AuthUser {
  id: string
  email: string
  name?: string
  avatarUrl?: string
}

export interface AuthSubscription {
  id: string
  name: string
  plan: string
}

export type AuthRole = 'owner' | 'admin' | 'member'

export interface AuthState {
  user: AuthUser | null
  subscription: AuthSubscription | null
  role: AuthRole | null
  isAuthenticated: boolean
  isLoading: boolean
  /**
   * Whether the Tolaria Cloud API is currently reachable. `null` while the
   * initial probe is in flight, `true` once any API call has succeeded, and
   * `false` once an API call has failed with a network-level error (offline,
   * DNS, CORS preflight failure, or the server is down). The web build
   * surfaces this through a "Cloud unreachable" banner so users understand
   * why recent edits are queued rather than persisted (G73).
   */
  cloudReachable: boolean | null
  login: (providerId?: string) => void
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

export const AuthContext = createContext<AuthState | undefined>(undefined)
