import type { ApiClient } from './client'
import type {
  Agent,
  ApiKey,
  ApiKeyCreated,
  ApiKeyIn,
  AuditLog,
  Conflict,
  ConflictDetail,
  ConflictStatus,
  Dream,
  DreamIn,
  EpisodeDetail,
  Episode,
  EvalRun,
  Evidence,
  Experience,
  ExperienceCreated,
  ExperienceDetail,
  ExperienceIn,
  Feedback,
  FeedbackIn,
  FeedbackResult,
  Graph,
  Job,
  Me,
  Memory,
  MemoryIn,
  MemoryListParams,
  MemoryPatch,
  MemoryRelation,
  MemoryUsage,
  MemoryVersion,
  NamedIn,
  Page,
  Project,
  PromoteIn,
  Readiness,
  ResolveIn,
  RetrievalTrace,
  ReviewIn,
  SearchIn,
  SearchOut,
  Stats,
  UUID,
  Workspace,
  WorkspaceIn,
} from './types'

export interface CursorParams {
  limit?: number
  cursor?: string
}

const enc = encodeURIComponent

// ------------------------------------------------------------------ identity / tenancy
export const getMe = (c: ApiClient) => c.get<Me>('/v1/me')
export const listWorkspaces = (c: ApiClient) => c.get<Workspace[]>('/v1/workspaces')
export const createWorkspace = (c: ApiClient, body: WorkspaceIn) => c.post<Workspace>('/v1/workspaces', body)
export const listProjects = (c: ApiClient, ws: UUID) => c.get<Project[]>(`/v1/workspaces/${enc(ws)}/projects`)
export const createProject = (c: ApiClient, ws: UUID, body: NamedIn) =>
  c.post<Project>(`/v1/workspaces/${enc(ws)}/projects`, body)
export const listAgents = (c: ApiClient, ws: UUID) => c.get<Agent[]>(`/v1/workspaces/${enc(ws)}/agents`)
export const createAgent = (c: ApiClient, ws: UUID, body: NamedIn) =>
  c.post<Agent>(`/v1/workspaces/${enc(ws)}/agents`, body)
export const listApiKeys = (c: ApiClient) => c.get<ApiKey[]>('/v1/api-keys')
export const createApiKey = (c: ApiClient, body: ApiKeyIn) => c.post<ApiKeyCreated>('/v1/api-keys', body)
export const revokeApiKey = (c: ApiClient, id: UUID) => c.delete<ApiKey>(`/v1/api-keys/${enc(id)}`)

// ------------------------------------------------------------------ memories
export const listMemories = (c: ApiClient, params: MemoryListParams) =>
  c.get<Page<Memory>>('/v1/memories', { ...params })
export const searchMemories = (c: ApiClient, body: SearchIn) =>
  c.post<SearchOut>('/v1/memories/search', body, { idempotencyKey: false })
export const getMemory = (c: ApiClient, id: UUID) => c.get<Memory>(`/v1/memories/${enc(id)}`)
export const createMemory = (c: ApiClient, body: MemoryIn) => c.post<Memory>('/v1/memories', body)
export const patchMemory = (c: ApiClient, id: UUID, version: number, body: MemoryPatch) =>
  c.patch<Memory>(`/v1/memories/${enc(id)}`, body, { ifMatch: version })
export const archiveMemory = (c: ApiClient, id: UUID, version: number, reason?: string) =>
  c.delete<Memory>(`/v1/memories/${enc(id)}`, { ifMatch: version, query: { reason } })
export const getMemoryEvidence = (c: ApiClient, id: UUID) =>
  c.get<Evidence[]>(`/v1/memories/${enc(id)}/evidence`)
export const getMemoryHistory = (c: ApiClient, id: UUID) =>
  c.get<MemoryVersion[]>(`/v1/memories/${enc(id)}/history`)
export const getMemoryRelations = (c: ApiClient, id: UUID) =>
  c.get<MemoryRelation[]>(`/v1/memories/${enc(id)}/relations`)
export const getMemoryUsage = (c: ApiClient, id: UUID) =>
  c.get<MemoryUsage[]>(`/v1/memories/${enc(id)}/usage`)
export const getMemoryFeedback = (c: ApiClient, id: UUID) =>
  c.get<Feedback[]>(`/v1/memories/${enc(id)}/feedback`)
export const submitFeedback = (c: ApiClient, id: UUID, body: FeedbackIn) =>
  c.post<FeedbackResult>(`/v1/memories/${enc(id)}/feedback`, body)
export const reviewMemory = (c: ApiClient, id: UUID, body: ReviewIn) =>
  c.post<Memory>(`/v1/memories/${enc(id)}/review`, body)
export const promoteMemory = (c: ApiClient, id: UUID, body: PromoteIn) =>
  c.post<Memory>(`/v1/memories/${enc(id)}/promote`, body)

// ------------------------------------------------------------------ experiences / episodes
export interface ExperienceListParams extends CursorParams {
  workspace_id: UUID
  outcome?: string
  project_id?: UUID
  agent_id?: UUID
}
export const listExperiences = (c: ApiClient, params: ExperienceListParams) =>
  c.get<Page<Experience>>('/v1/experiences', { ...params })
export const getExperience = (c: ApiClient, id: UUID) => c.get<ExperienceDetail>(`/v1/experiences/${enc(id)}`)
export const createExperience = (c: ApiClient, body: ExperienceIn) =>
  c.post<ExperienceCreated>('/v1/experiences', body)
export const listEpisodes = (c: ApiClient, params: CursorParams & { workspace_id: UUID }) =>
  c.get<Page<Episode>>('/v1/episodes', { ...params })
export const getEpisode = (c: ApiClient, id: UUID) => c.get<EpisodeDetail>(`/v1/episodes/${enc(id)}`)

// ------------------------------------------------------------------ dreams / conflicts
export const listDreams = (c: ApiClient, params: CursorParams & { workspace_id: UUID }) =>
  c.get<Page<Dream>>('/v1/dreams', { ...params })
export const getDream = (c: ApiClient, id: UUID) => c.get<Dream>(`/v1/dreams/${enc(id)}`)
export const requestDream = (c: ApiClient, body: DreamIn) => c.post<Dream>('/v1/dreams', body)

export const listConflicts = (
  c: ApiClient,
  params: CursorParams & { workspace_id?: UUID; status?: ConflictStatus },
) => c.get<Page<Conflict>>('/v1/conflicts', { ...params })
export const getConflict = (c: ApiClient, id: UUID) => c.get<ConflictDetail>(`/v1/conflicts/${enc(id)}`)
export const resolveConflict = (c: ApiClient, id: UUID, body: ResolveIn) =>
  c.post<ConflictDetail>(`/v1/conflicts/${enc(id)}/resolve`, body)

// ------------------------------------------------------------------ operations
export const getStats = (c: ApiClient, ws: UUID) => c.get<Stats>('/v1/stats', { workspace_id: ws })
export const getGraph = (c: ApiClient, ws: UUID, opts: { includeInactive?: boolean; limit?: number } = {}) =>
  c.get<Graph>('/v1/graph', { workspace_id: ws, include_inactive: opts.includeInactive, limit: opts.limit })
export const listAuditLogs = (
  c: ApiClient,
  params: CursorParams & { workspace_id?: UUID; resource_id?: string; action?: string },
) => c.get<Page<AuditLog>>('/v1/audit-logs', { ...params })
export const listJobs = (
  c: ApiClient,
  params: CursorParams & { workspace_id?: UUID; status?: string; kind?: string },
) => c.get<Page<Job>>('/v1/jobs', { ...params })
export const retryJob = (c: ApiClient, id: UUID) =>
  c.post<{ requeued: boolean }>(`/v1/jobs/${enc(id)}/retry`, undefined)
export const listTraces = (c: ApiClient, params: CursorParams & { workspace_id: UUID }) =>
  c.get<Page<RetrievalTrace>>('/v1/retrieval-traces', { ...params })
export const getTrace = (c: ApiClient, id: UUID) => c.get<RetrievalTrace>(`/v1/retrieval-traces/${enc(id)}`)
export const listEvalRuns = (c: ApiClient, params: CursorParams & { workspace_id?: UUID }) =>
  c.get<Page<EvalRun>>('/v1/evals/runs', { ...params })
/** Readiness returns 503 with the same body shape when a dependency is down. */
export const getReadiness = (c: ApiClient) =>
  c.get<Readiness>('/health/ready', undefined, { acceptStatuses: [503] })
