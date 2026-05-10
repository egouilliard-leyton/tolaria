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
  login: (providerId?: string) => void
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

export const AuthContext = createContext<AuthState | undefined>(undefined)
