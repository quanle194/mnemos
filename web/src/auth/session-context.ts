import { createContext, useContext } from 'react'
import type { ApiClient } from '@/api/client'

export interface LoginInput {
  apiUrl?: string | null
  apiKey: string
  workspaceId?: string | null
}

export interface SessionValue {
  apiUrl: string | null
  apiKey: string | null
  workspaceId: string | null
  /** Effective base URL used for requests. */
  effectiveApiUrl: string
  client: ApiClient
  isAuthenticated: boolean
  login: (input: LoginInput) => void
  setWorkspace: (workspaceId: string) => void
  logout: (reason?: string) => void
}

export const SessionContext = createContext<SessionValue | null>(null)

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>')
  return ctx
}

export function useApiClient(): ApiClient {
  return useSession().client
}

/** Active workspace id. Only call inside the authenticated layout, which guarantees one is selected. */
export function useWorkspaceId(): string {
  const { workspaceId } = useSession()
  if (!workspaceId) throw new Error('No active workspace selected')
  return workspaceId
}
