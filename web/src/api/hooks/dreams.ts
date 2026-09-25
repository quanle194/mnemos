import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
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
  return useCursorList<Dream>(qk.dreams.list(ws), (cursor) =>
    api.listDreams(client, { workspace_id: ws, limit: PAGE_SIZE, cursor }),
  )
}

export function useDream(id: UUID) {
  const client = useApiClient()
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: qk.dreams.detail(id),
    queryFn: () => api.getDream(client, id),
    refetchInterval: (q) => (isDreamActive(q.state.data) ? DREAM_POLL_MS : false),
  })

  // When a dream finishes it may have changed memories/conflicts/stats: refresh dependants once.
  // (Never invalidate from inside queryFn: that cancels and restarts this very query.)
  const status = query.data?.status
  const wasActive = useRef<boolean | null>(null)
  useEffect(() => {
    if (!status) return
    const active = status === 'queued' || status === 'running'
    if (wasActive.current === true && !active) {
      void qc.invalidateQueries({ queryKey: ['dreams', 'list'] })
      void qc.invalidateQueries({ queryKey: qk.memories.all })
      void qc.invalidateQueries({ queryKey: qk.conflicts.all })
      void qc.invalidateQueries({ queryKey: ['stats'] })
      void qc.invalidateQueries({ queryKey: ['graph'] })
    }
    wasActive.current = active
  }, [status, qc])

  return query
}

export function useRequestDream() {
  const client = useApiClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: DreamIn) => api.requestDream(client, body),
    onSuccess: (d) => {
      qc.setQueryData(qk.dreams.detail(d.id), d)
      void qc.invalidateQueries({ queryKey: ['dreams', 'list'] })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })
}
