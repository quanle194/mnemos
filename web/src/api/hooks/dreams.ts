import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '@/auth/session-context'
import * as api from '../endpoints'
import { qk } from '../keys'
import type { Dream, DreamIn, UUID } from '../types'
import { PAGE_SIZE, useCursorList } from './pagination'

export const DREAM_POLL_MS = 2000

export function isDreamActive(d: Pick<Dream, 'status'> | undefined): boolean {
  return d?.status === 'queued' || d?.status === 'running'
}

export function useDreamList(ws: UUID) {
  const client = useApiClient()
  const list = useCursorList<Dream>(qk.dreams.list(ws), (cursor) =>
    api.listDreams(client, { workspace_id: ws, limit: PAGE_SIZE, cursor }),
  )
  return list
}

export function useDream(id: UUID) {
  const client = useApiClient()
  const qc = useQueryClient()
  return useQuery({
    queryKey: qk.dreams.detail(id),
    queryFn: async () => {
      const prev = qc.getQueryData<Dream>(qk.dreams.detail(id))
      const d = await api.getDream(client, id)
      // A dream that just finished changes memories/conflicts/stats: refresh dependants once.
      if (prev && isDreamActive(prev) && !isDreamActive(d)) {
        void qc.invalidateQueries({ queryKey: qk.dreams.all })
        void qc.invalidateQueries({ queryKey: qk.memories.all })
        void qc.invalidateQueries({ queryKey: qk.conflicts.all })
        void qc.invalidateQueries({ queryKey: ['stats'] })
        void qc.invalidateQueries({ queryKey: ['graph'] })
      }
      return d
    },
    refetchInterval: (query) => (isDreamActive(query.state.data) ? DREAM_POLL_MS : false),
  })
}

export function useRequestDream() {
  const client = useApiClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: DreamIn) => api.requestDream(client, body),
    onSuccess: (d) => {
      qc.setQueryData(qk.dreams.detail(d.id), d)
      void qc.invalidateQueries({ queryKey: qk.dreams.all })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })
}
