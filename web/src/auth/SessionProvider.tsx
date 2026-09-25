import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { ApiClient, ApiError, resolveApiUrl } from '@/api/client'
import { SessionContext, type LoginInput, type SessionValue } from './session-context'
import { clearSession, EMPTY_SESSION, loadSession, saveSession, type StoredSession } from './storage'

interface Props {
  children: ReactNode
  /** Initial state (tests); defaults to the persisted session. */
  initial?: StoredSession
  fetchFn?: typeof fetch
}

export function SessionProvider({ children, initial, fetchFn }: Props) {
  const queryClient = useQueryClient()
  const [state, setState] = useState<StoredSession>(() => initial ?? loadSession())

  const update = useCallback((next: StoredSession) => {
    setState(next)
    if (next.apiKey) saveSession(next)
    else clearSession()
  }, [])

  const login = useCallback(
    (input: LoginInput) => {
      queryClient.clear()
      update({ apiUrl: input.apiUrl?.trim() || null, apiKey: input.apiKey.trim(), workspaceId: input.workspaceId ?? null })
    },
    [queryClient, update],
  )

  const setWorkspace = useCallback(
    (workspaceId: string) => {
      setState((prev) => {
        const next = { ...prev, workspaceId }
        if (next.apiKey) saveSession(next)
        return next
      })
    },
    [],
  )

  const logout = useCallback(
    (reason?: string) => {
      queryClient.clear()
      update(EMPTY_SESSION)
      if (reason) toast.error(reason)
    },
    [queryClient, update],
  )

  // A 401 from any query means the key was revoked/invalid: drop the session.
  useEffect(() => {
    if (!state.apiKey) return
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return
      const err = event.action.error
      if (err instanceof ApiError && err.isUnauthorized) {
        logout('Your API key was rejected (401). Please sign in again.')
      }
    })
  }, [queryClient, logout, state.apiKey])

  const client = useMemo(
    () => new ApiClient({ baseUrl: state.apiUrl, apiKey: state.apiKey, fetchFn }),
    [state.apiUrl, state.apiKey, fetchFn],
  )

  const value = useMemo<SessionValue>(
    () => ({
      ...state,
      effectiveApiUrl: resolveApiUrl(state.apiUrl),
      client,
      isAuthenticated: Boolean(state.apiKey),
      login,
      setWorkspace,
      logout,
    }),
    [state, client, login, setWorkspace, logout],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
