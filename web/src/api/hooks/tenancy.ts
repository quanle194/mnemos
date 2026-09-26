import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient, useSession } from '@/auth/session-context'
import * as api from '../endpoints'
import { qk } from '../keys'
import type { ApiKeyIn, NamedIn, UUID, WorkspaceIn } from '../types'

export function useMe() {
  const { client, isAuthenticated } = useSession()
  return useQuery({
    queryKey: qk.me,
    queryFn: () => api.getMe(client),
    enabled: isAuthenticated,
    staleTime: 60_000,
  })
}

export function useWorkspaces() {
  const { client, isAuthenticated } = useSession()
  return useQuery({
    queryKey: qk.workspaces,
    queryFn: () => api.listWorkspaces(client),
    enabled: isAuthenticated,
    staleTime: 30_000,
  })
}

export function useCreateWorkspace() {
  const client = useApiClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: WorkspaceIn) => api.createWorkspace(client, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.workspaces }),
  })
}

export function useProjects(ws: UUID | null) {
  const client = useApiClient()
  return useQuery({
    queryKey: qk.projects(ws ?? ''),
    queryFn: () => api.listProjects(client, ws!),
    enabled: Boolean(ws),
  })
}

export function useCreateProject(ws: UUID) {
  const client = useApiClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: NamedIn) => api.createProject(client, ws, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.projects(ws) }),
  })
}

export function useAgents(ws: UUID | null) {
  const client = useApiClient()
  return useQuery({
    queryKey: qk.agents(ws ?? ''),
    queryFn: () => api.listAgents(client, ws!),
    enabled: Boolean(ws),
  })
}

export function useCreateAgent(ws: UUID) {
  const client = useApiClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: NamedIn) => api.createAgent(client, ws, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.agents(ws) }),
  })
}

export function useApiKeys(enabled = true) {
  const client = useApiClient()
  return useQuery({ queryKey: qk.apiKeys, queryFn: () => api.listApiKeys(client), enabled })
}

export function useCreateApiKey() {
  const client = useApiClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ApiKeyIn) => api.createApiKey(client, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.apiKeys }),
  })
}

export function useRevokeApiKey() {
  const client = useApiClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => api.revokeApiKey(client, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.apiKeys }),
  })
}
