import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '@/auth/session-context'
import * as api from '../endpoints'
import { qk } from '../keys'
import type { Episode, Experience, ExperienceDetail, ExperienceIn, UUID } from '../types'
import { PAGE_SIZE, useCursorList } from './pagination'

export const LEARNING_POLL_MS = 2000
export const LEARNING_FAILED_POLL_MS = 10_000

/** Poll while learning has not finished: fast while pending, slow after a failure (jobs may be retried). */
export function learningPollInterval(exp: Pick<ExperienceDetail, 'processing_status'> | undefined): number | false {
  if (!exp) return false
  if (exp.processing_status === 'processed') return false
  return exp.processing_status === 'failed' ? LEARNING_FAILED_POLL_MS : LEARNING_POLL_MS
}

export function useExperienceList(ws: UUID, outcome?: string) {
  const client = useApiClient()
  return useCursorList<Experience>(qk.experiences.list(ws, outcome), (cursor) =>
    api.listExperiences(client, { workspace_id: ws, outcome: outcome || undefined, limit: PAGE_SIZE, cursor }),
  )
}

export function useExperience(id: UUID) {
  const client = useApiClient()
  return useQuery({
    queryKey: qk.experiences.detail(id),
    queryFn: () => api.getExperience(client, id),
    refetchInterval: (query) => learningPollInterval(query.state.data),
  })
}

export function useCreateExperience() {
  const client = useApiClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ExperienceIn) => api.createExperience(client, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.experiences.all })
      void qc.invalidateQueries({ queryKey: qk.episodes.all })
      void qc.invalidateQueries({ queryKey: ['stats'] })
    },
  })
}

export function useEpisodeList(ws: UUID) {
  const client = useApiClient()
  return useCursorList<Episode>(qk.episodes.list(ws), (cursor) =>
    api.listEpisodes(client, { workspace_id: ws, limit: PAGE_SIZE, cursor }),
  )
}

export function useEpisode(id: UUID) {
  const client = useApiClient()
  return useQuery({ queryKey: qk.episodes.detail(id), queryFn: () => api.getEpisode(client, id) })
}
