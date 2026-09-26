import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '@/auth/session-context'
import * as api from '../endpoints'
import { qk } from '../keys'
import type {
  FeedbackIn,
  Memory,
  MemoryIn,
  MemoryListParams,
  MemoryPatch,
  PromoteIn,
  ReviewIn,
  SearchIn,
  UUID,
} from '../types'
import { PAGE_SIZE, useCursorList } from './pagination'

export function useMemoryList(params: MemoryListParams) {
  const client = useApiClient()
  return useCursorList<Memory>(qk.memories.list(params), (cursor) =>
    api.listMemories(client, { ...params, limit: PAGE_SIZE, cursor }),
  )
}

export function useMemory(id: UUID) {
  const client = useApiClient()
  return useQuery({ queryKey: qk.memories.detail(id), queryFn: () => api.getMemory(client, id) })
}

export function useMemoryEvidence(id: UUID) {
  const client = useApiClient()
  return useQuery({ queryKey: qk.memories.evidence(id), queryFn: () => api.getMemoryEvidence(client, id) })
}

export function useMemoryHistory(id: UUID) {
  const client = useApiClient()
  return useQuery({ queryKey: qk.memories.history(id), queryFn: () => api.getMemoryHistory(client, id) })
}

export function useMemoryRelations(id: UUID) {
  const client = useApiClient()
  return useQuery({ queryKey: qk.memories.relations(id), queryFn: () => api.getMemoryRelations(client, id) })
}

export function useMemoryUsage(id: UUID) {
  const client = useApiClient()
  return useQuery({ queryKey: qk.memories.usage(id), queryFn: () => api.getMemoryUsage(client, id) })
}

export function useMemoryFeedback(id: UUID) {
  const client = useApiClient()
  return useQuery({ queryKey: qk.memories.feedback(id), queryFn: () => api.getMemoryFeedback(client, id) })
}

/** Semantic/hybrid search is a POST that records a retrieval trace, so it runs on demand (mutation). */
export function useSearchMemories() {
  const client = useApiClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SearchIn) => api.searchMemories(client, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.traces.all }),
  })
}

export function useCreateMemory() {
  const client = useApiClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: MemoryIn) => api.createMemory(client, body),
    onSuccess: (m) => {
      qc.setQueryData(qk.memories.detail(m.id), m)
      void qc.invalidateQueries({ queryKey: qk.memories.all })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })
}

/** After any memory mutation: seed the detail cache and refresh everything derived from it. */
function useMemoryMutationSuccess(id: UUID) {
  const qc = useQueryClient()
  return (m: Memory) => {
    qc.setQueryData(qk.memories.detail(id), m)
    void qc.invalidateQueries({ queryKey: qk.memories.all })
    void qc.invalidateQueries({ queryKey: ['stats'] })
    void qc.invalidateQueries({ queryKey: ['graph'] })
    void qc.invalidateQueries({ queryKey: ['audit'] })
  }
}

export function usePatchMemory(id: UUID) {
  const client = useApiClient()
  const onSuccess = useMemoryMutationSuccess(id)
  return useMutation({
    mutationFn: ({ version, patch }: { version: number; patch: MemoryPatch }) =>
      api.patchMemory(client, id, version, patch),
    onSuccess,
  })
}

export function useArchiveMemory(id: UUID) {
  const client = useApiClient()
  const onSuccess = useMemoryMutationSuccess(id)
  return useMutation({
    mutationFn: ({ version, reason }: { version: number; reason?: string }) =>
      api.archiveMemory(client, id, version, reason),
    onSuccess,
  })
}

export function useReviewMemory(id: UUID) {
  const client = useApiClient()
  const onSuccess = useMemoryMutationSuccess(id)
  return useMutation({ mutationFn: (body: ReviewIn) => api.reviewMemory(client, id, body), onSuccess })
}

export function usePromoteMemory(id: UUID) {
  const client = useApiClient()
  const onSuccess = useMemoryMutationSuccess(id)
  return useMutation({ mutationFn: (body: PromoteIn) => api.promoteMemory(client, id, body), onSuccess })
}

export function useSubmitFeedback(id: UUID) {
  const client = useApiClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: FeedbackIn) => api.submitFeedback(client, id, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.memories.detail(id) })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })
}
