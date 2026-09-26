import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '@/auth/session-context'
import * as api from '../endpoints'
import { qk } from '../keys'
import type { AuditLog, EvalRun, Job, RetrievalTrace, UUID } from '../types'
import { PAGE_SIZE, useCursorList } from './pagination'

export function useStats(ws: UUID) {
  const client = useApiClient()
  return useQuery({
    queryKey: qk.stats(ws),
    queryFn: () => api.getStats(client, ws),
    refetchInterval: 30_000,
  })
}

export function useGraph(ws: UUID, includeInactive: boolean) {
  const client = useApiClient()
  return useQuery({
    queryKey: qk.graph(ws, includeInactive),
    queryFn: () => api.getGraph(client, ws, { includeInactive, limit: 300 }),
  })
}

export function useAuditLogs(ws: UUID) {
  const client = useApiClient()
  return useCursorList<AuditLog>(qk.audit(ws), (cursor) =>
    api.listAuditLogs(client, { workspace_id: ws, limit: 15, cursor }),
  )
}

export function useJobs(ws: UUID, status?: string) {
  const client = useApiClient()
  return useCursorList<Job>(qk.jobs(ws, status), (cursor) =>
    api.listJobs(client, { workspace_id: ws, status: status || undefined, limit: PAGE_SIZE, cursor }),
  )
}

export function useRetryJob() {
  const client = useApiClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: UUID) => api.retryJob(client, id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })
}

export function useTraces(ws: UUID) {
  const client = useApiClient()
  return useCursorList<RetrievalTrace>(qk.traces.list(ws), (cursor) =>
    api.listTraces(client, { workspace_id: ws, limit: PAGE_SIZE, cursor }),
  )
}

export function useTrace(id: UUID) {
  const client = useApiClient()
  return useQuery({ queryKey: qk.traces.detail(id), queryFn: () => api.getTrace(client, id) })
}

export function useEvalRuns(ws: UUID | null) {
  const client = useApiClient()
  return useCursorList<EvalRun>(qk.evals(ws), (cursor) =>
    api.listEvalRuns(client, { workspace_id: ws ?? undefined, limit: PAGE_SIZE, cursor }),
  )
}

export function useReadiness() {
  const client = useApiClient()
  return useQuery({
    queryKey: qk.readiness,
    queryFn: () => api.getReadiness(client),
    refetchInterval: 15_000,
  })
}
