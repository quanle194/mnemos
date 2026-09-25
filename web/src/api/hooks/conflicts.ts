import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '@/auth/session-context'
import * as api from '../endpoints'
import { qk } from '../keys'
import type { Conflict, ConflictStatus, ResolveIn, UUID } from '../types'
import { PAGE_SIZE, useCursorList } from './pagination'

export function useConflictList(ws: UUID, status?: ConflictStatus) {
  const client = useApiClient()
  return useCursorList<Conflict>(qk.conflicts.list(ws, status), (cursor) =>
    api.listConflicts(client, { workspace_id: ws, status, limit: PAGE_SIZE, cursor }),
  )
}

export function useConflict(id: UUID) {
  const client = useApiClient()
  return useQuery({ queryKey: qk.conflicts.detail(id), queryFn: () => api.getConflict(client, id) })
}

export function useResolveConflict(id: UUID) {
  const client = useApiClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ResolveIn) => api.resolveConflict(client, id, body),
    onSuccess: (detail) => {
      qc.setQueryData(qk.conflicts.detail(id), detail)
      void qc.invalidateQueries({ queryKey: qk.conflicts.all })
      void qc.invalidateQueries({ queryKey: qk.memories.all })
      void qc.invalidateQueries({ queryKey: ['stats'] })
      void qc.invalidateQueries({ queryKey: ['graph'] })
    },
  })
}
