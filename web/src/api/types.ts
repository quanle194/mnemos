/**
 * TypeScript mirror of the Mnemos REST contract (docs/openapi.json, backend/app/schemas/*.py).
 * UUIDs and datetimes travel as strings (ISO-8601 UTC for datetimes).
 */

export type UUID = string
export type ISODateTime = string
export type JsonObject = Record<string, unknown>

// ------------------------------------------------------------------ enums
export const MEMORY_TYPES = [
  'fact',
  'preference',
  'procedure',
  'rule',
  'constraint',
  'decision',
  'lesson',
  'pattern',
  'warning',
  'failure',
  'success',
  'relationship',
  'context',
] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export const MEMORY_STATUSES = [
  'candidate',
  'validated',
  'active',
  'disputed',
  'superseded',
  'archived',
  'rejected',
] as const
export type MemoryStatus = (typeof MEMORY_STATUSES)[number]

export const SCOPE_TYPES = ['organization', 'workspace', 'project', 'agent', 'session'] as const
export type ScopeType = (typeof SCOPE_TYPES)[number]

export const REVIEW_STATES = ['none', 'pending', 'approved', 'rejected'] as const
export type ReviewState = (typeof REVIEW_STATES)[number]

export const RELATION_TYPES = [
  'supports',
  'contradicts',
  'supersedes',
  'derived_from',
  'related_to',
  'generalizes',
  'specializes',
] as const
export type RelationType = (typeof RELATION_TYPES)[number]

export const FEEDBACK_VALUES = ['helpful', 'irrelevant', 'incorrect', 'outdated', 'harmful'] as const
export type FeedbackValue = (typeof FEEDBACK_VALUES)[number]

export const OUTCOMES = ['success', 'failure', 'partial', 'unknown'] as const
export type Outcome = (typeof OUTCOMES)[number]

export const EXPERIENCE_SOURCES = ['agent', 'user', 'tool', 'external'] as const
export type ExperienceSource = (typeof EXPERIENCE_SOURCES)[number]

export const DREAM_MODES = [
  'reflection',
  'deduplication',
  'pattern',
  'contradiction',
  'generalization',
  'compression',
] as const
export type DreamMode = (typeof DREAM_MODES)[number]

export const DREAM_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const
export type DreamStatus = (typeof DREAM_STATUSES)[number]

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const CONFLICT_STATUSES = ['open', 'resolved'] as const
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number]

export const CONFLICT_RESOLUTIONS = ['keep_existing', 'accept_candidate', 'keep_both', 'archive_both'] as const
export type ConflictResolution = (typeof CONFLICT_RESOLUTIONS)[number]

export const ROLES = ['admin', 'maintainer', 'agent', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export const PERMISSIONS = [
  'memory:read',
  'experience:write',
  'memory:propose',
  'feedback:write',
  'memory:review',
  'dream:run',
  'workspace:manage',
] as const
export type Permission = (typeof PERMISSIONS)[number]

export type ProcessingStatus = 'pending' | 'processed' | 'failed'

// ------------------------------------------------------------------ common
export interface Page<T> {
  items: T[]
  next_cursor: string | null
}

export interface ErrorBody {
  code: string
  message: string
  details: JsonObject
  request_id: string | null
}

export interface ErrorResponse {
  error: ErrorBody
}

// ------------------------------------------------------------------ identity / tenancy
export interface Me {
  organization_id: UUID
  role: Role
  actor_id: string
  permissions: Permission[]
  workspace_ids: UUID[] | null
}

export interface Workspace {
  id: UUID
  organization_id: UUID
  name: string
  settings_json: JsonObject
  created_at: ISODateTime
}

export interface WorkspaceIn {
  name: string
  settings_json?: JsonObject
}

export interface Project {
  id: UUID
  workspace_id: UUID
  name: string
  created_at: ISODateTime
}

export interface Agent {
  id: UUID
  workspace_id: UUID
  name: string
  kind: string
  metadata_json: JsonObject
  created_at: ISODateTime
}

export interface NamedIn {
  name: string
  kind?: string
  metadata?: JsonObject
}

export interface ApiKey {
  id: UUID
  name: string
  prefix: string
  role: Role
  workspace_ids: UUID[] | null
  created_at: ISODateTime
  revoked_at: ISODateTime | null
  last_used_at: ISODateTime | null
}

export interface ApiKeyCreated extends ApiKey {
  api_key: string
}

export interface ApiKeyIn {
  name: string
  role: Role
  workspace_ids?: UUID[] | null
}

// ------------------------------------------------------------------ memories
export interface Memory {
  id: UUID
  organization_id: UUID
  workspace_id: UUID | null
  project_id: UUID | null
  agent_id: UUID | null
  layer: number
  type: MemoryType
  scope_type: ScopeType
  scope_id: UUID
  title: string
  content: string
  status: MemoryStatus
  review_state: ReviewState
  confidence: number
  trust_score: number
  importance: number
  utility_score: number
  valid_from: ISODateTime
  valid_until: ISODateTime | null
  version: number
  metadata_json: JsonObject
  retrieval_count: number
  last_retrieved_at: ISODateTime | null
  created_by_type: string
  created_by_id: string | null
  created_at: ISODateTime
  updated_at: ISODateTime
}

export interface EvidenceIn {
  source_type: string
  source_id: string
  relation?: 'supports' | 'derived_from' | 'contradicts'
  weight?: number
  excerpt?: string
}

export interface MemoryIn {
  workspace_id: UUID
  project_id?: UUID | null
  agent_id?: UUID | null
  session_id?: UUID | null
  project_name?: string | null
  agent_name?: string | null
  type: MemoryType
  scope_type?: ScopeType
  title: string
  content: string
  confidence?: number
  importance?: number
  valid_from?: ISODateTime | null
  valid_until?: ISODateTime | null
  status?: 'candidate' | 'active'
  layer?: 3 | 4
  evidence?: EvidenceIn[]
  metadata?: JsonObject
}

export interface MemoryPatch {
  expected_version?: number
  title?: string
  content?: string
  type?: MemoryType
  importance?: number
  confidence?: number
  valid_from?: ISODateTime | null
  valid_until?: ISODateTime | null
  status?: MemoryStatus
  metadata?: JsonObject
  reason?: string
}

export interface MemoryListParams {
  workspace_id?: UUID
  status?: MemoryStatus | MemoryStatus[]
  type?: MemoryType | MemoryType[]
  scope_type?: ScopeType
  project_id?: UUID
  layer?: number
  review_state?: ReviewState
  q?: string
  limit?: number
  cursor?: string
}

export interface ReviewIn {
  approve: boolean
  note?: string
  expected_version?: number | null
}

export interface PromoteIn {
  scope_type?: 'workspace' | 'organization'
  expected_version?: number | null
  note?: string
}

export interface MemoryVersion {
  id: UUID
  version: number
  snapshot_json: JsonObject
  change_reason: string
  actor_type: string
  actor_id: string | null
  created_at: ISODateTime
}

export interface Evidence {
  id: UUID
  source_type: string
  source_id: string
  relation: string
  weight: number
  excerpt: string
  created_at: ISODateTime
  source: JsonObject | null
}

export interface RelationOther {
  id: UUID
  title: string
  status: MemoryStatus
  type: MemoryType
}

export interface MemoryRelation {
  id: UUID
  relation: RelationType
  direction: 'outgoing' | 'incoming'
  other: RelationOther
  metadata: JsonObject
  created_at: ISODateTime
}

export interface MemoryUsage {
  trace_id: UUID
  kind: string
  query: string
  rank: number
  score: number
  agent_id: UUID | null
  created_at: ISODateTime
}

export interface FeedbackIn {
  value: FeedbackValue
  note?: string
  agent_id?: UUID | null
  session_id?: UUID | null
  task_id?: string | null
  retrieval_trace_id?: UUID | null
}

export interface Feedback {
  id: UUID
  memory_id: UUID
  value: FeedbackValue
  note: string
  agent_id: UUID | null
  task_id: string | null
  retrieval_trace_id: UUID | null
  created_at: ISODateTime
}

export interface FeedbackResult {
  feedback: Feedback
  memory: JsonObject
}

// ------------------------------------------------------------------ retrieval
export interface SearchIn {
  workspace_id: UUID
  project_id?: UUID | null
  agent_id?: UUID | null
  session_id?: UUID | null
  query: string
  types?: MemoryType[] | null
  statuses?: MemoryStatus[] | null
  layers?: (3 | 4)[] | null
  scope_mode?: 'chain' | 'workspace' | null
  valid_at?: ISODateTime | null
  limit?: number
  min_relevance?: number
}

export type ScoreBreakdown = Record<string, number>

export interface ScoredMemory {
  memory: Memory
  score: number
  scores: ScoreBreakdown
  reasons: string[]
}

export interface SearchOut {
  items: ScoredMemory[]
  retrieval_trace_id: UUID
  weights: Record<string, number>
}

export interface RetrievalTrace {
  id: UUID
  workspace_id: UUID
  kind: string
  query: string
  request_json: JsonObject
  candidates_json: JsonObject
  selected_json: JsonObject
  context_tokens: number
  latency_ms: number
  agent_id: UUID | null
  created_at: ISODateTime
}

// ------------------------------------------------------------------ experiences / episodes
export interface ExperienceIn {
  workspace_id: UUID
  project_id?: UUID | null
  agent_id?: UUID | null
  session_id?: UUID | null
  project_name?: string | null
  agent_name?: string | null
  task_id?: string | null
  task: string
  observation?: string
  action?: string
  result?: string
  outcome: Outcome
  importance?: number
  confidence?: number
  source?: ExperienceSource
  metadata?: JsonObject
}

export interface Experience {
  id: UUID
  workspace_id: UUID
  project_id: UUID | null
  agent_id: UUID | null
  session_id: UUID | null
  task_id: string | null
  episode_id: UUID | null
  task: string
  observation: string
  action: string
  result: string
  outcome: Outcome
  importance: number
  confidence: number
  source: ExperienceSource
  source_trust: number
  metadata_json: JsonObject
  processing_status: ProcessingStatus
  processed_at: ISODateTime | null
  created_at: ISODateTime
}

export interface LearnedMemoryRef {
  id: UUID
  title: string
  status: MemoryStatus
  type: MemoryType
}

export interface LearningStatus {
  job_id: string | null
  job_status: string | null
  processing_status: ProcessingStatus
  memories: LearnedMemoryRef[]
}

export interface ExperienceCreated {
  experience: Experience
  learning: LearningStatus
}

export interface ExperienceDetail extends Experience {
  learning: LearningStatus | null
}

export interface Episode {
  id: UUID
  workspace_id: UUID
  project_id: UUID | null
  agent_id: UUID | null
  session_id: UUID | null
  task_id: string | null
  summary: string
  outcome: Outcome
  importance: number
  confidence: number
  experience_count: number
  started_at: ISODateTime
  completed_at: ISODateTime | null
  updated_at: ISODateTime
}

export interface EpisodeDetail extends Episode {
  experiences: Experience[]
}

// ------------------------------------------------------------------ conflicts / dreams / jobs / audit
export interface Conflict {
  id: UUID
  workspace_id: UUID | null
  candidate_memory_id: UUID
  existing_memory_id: UUID
  conflict_type: string
  status: ConflictStatus
  analysis_json: JsonObject
  resolution_json: JsonObject
  created_at: ISODateTime
  resolved_at: ISODateTime | null
}

export interface ConflictDetail extends Conflict {
  candidate: Memory | null
  existing: Memory | null
}

export interface ResolveIn {
  resolution: ConflictResolution
  note?: string
}

export interface DreamIn {
  workspace_id: UUID
  mode: DreamMode
  dedupe_window?: boolean
}

export interface Dream {
  id: UUID
  workspace_id: UUID
  mode: DreamMode
  status: DreamStatus
  trigger_type: string
  window_hash: string | null
  input_window_json: JsonObject
  result_json: JsonObject
  checkpoint_json: JsonObject
  error: string | null
  started_at: ISODateTime | null
  completed_at: ISODateTime | null
  created_at: ISODateTime
}

export interface Job {
  id: UUID
  kind: string
  status: JobStatus
  attempts: number
  max_attempts: number
  payload_json: JsonObject
  last_error: string | null
  result_json: JsonObject
  run_after: ISODateTime
  created_at: ISODateTime
  completed_at: ISODateTime | null
}

export interface AuditLog {
  id: UUID
  workspace_id: UUID | null
  actor_type: string
  actor_id: string | null
  action: string
  resource_type: string
  resource_id: string | null
  before_json: JsonObject
  after_json: JsonObject
  request_id: string | null
  created_at: ISODateTime
}

export interface EvalRun {
  id: UUID
  workspace_id: UUID | null
  name: string
  status: string
  summary_json: JsonObject
  result_json: JsonObject
  created_at: ISODateTime
}

// ------------------------------------------------------------------ stats / graph / health
export interface Stats {
  workspace_id: UUID
  memories_by_status: Record<string, number>
  memories_by_type: Record<string, number>
  memories_by_layer: Record<string, number>
  pending_review: number
  experiences_by_outcome: Record<string, number>
  conflicts_by_status: Record<string, number>
  dreams_by_status: Record<string, number>
  jobs_by_status: Record<string, number>
  feedback_by_value: Record<string, number>
  retrieval_24h: { count: number; avg_latency_ms: number; avg_context_tokens: number }
}

export interface GraphNode {
  id: UUID
  title: string
  type: MemoryType
  status: MemoryStatus
  layer: number
  confidence: number
  utility: number
}

export interface GraphEdge {
  id: UUID
  source: UUID
  target: UUID
  relation: RelationType
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface ReadinessChecks {
  database?: { ok: boolean; pgvector?: string | null; migration?: string | null; error?: string }
  queue?: Record<string, number>
  redis?: { ok: boolean }
  workers?: unknown
  providers?: { llm?: string; embedding?: string; embedding_dimensions?: number }
  [key: string]: unknown
}

export interface Readiness {
  status: 'ok' | 'unavailable' | string
  checks: ReadinessChecks
}
