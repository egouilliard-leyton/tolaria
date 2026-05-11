import { useContext } from 'react'
import { AuthContext, type AuthState } from './auth-context.js'

// The only sanctioned way for components to read auth state. Components
// must not poke at cookies or in-memory tokens directly.
export function useAuth(): AuthState {
  const value = useContext(AuthContext)
  if (!value) {
    throw new Error('useAuth() called outside of <AuthProvider>')
  }
  return value
}
