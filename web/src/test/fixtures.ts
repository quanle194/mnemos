import type {
  Conflict,
  ConflictDetail,
  Evidence,
  Experience,
  Feedback,
  Me,
  Memory,
  MemoryRelation,
  MemoryUsage,
  MemoryVersion,
  Permission,
  Role,
  Stats,
  Workspace,
} from '@/api/types'
import type { MockApi } from './mock-api'

export const ORG = '0192f0a0-0000-7000-8000-000000000001'
export const WS1 = '0192f0a0-0000-7000-8000-00000000a001'
export const WS2 = '0192f0a0-0000-7000-8000-00000000a002'
export const MEM1 = '0192f0a0-0000-7000-8000-00000000b001'
export const MEM2 = '0192f0a0-0000-7000-8000-00000000b002'
export const EXP1 = '0192f0a0-0000-7000-8000-00000000c001'
export const NOW = '2026-09-25T12:00:00Z'

const PERMS: Record<Role, Permission[]> = {
  viewer: ['memory:read'],
  agent: ['memory:read', 'experience:write', 'memory:propose', 'feedback:write'],
  maintainer: [
    'memory:read',
    'experience:write',
    'memory:propose',
    'feedback:write',
    'memory:review',
    'dream:run',
  ],
  admin: [
    'memory:read',
    'experience:write',
    'memory:propose',
    'feedback:write',
    'memory:review',
    'dream:run',
    'workspace:manage',
  ],
}

export function me(role: Role = 'admin'): Me {
  return {
    organization_id: ORG,
    role,
    actor_id: `api_key:key-${role}`,
    permissions: PERMS[role],
    workspace_ids: null,
  }
}

export const workspaces: Workspace[] = [
  { id: WS1, organization_id: ORG, name: 'default', settings_json: {}, created_at: NOW },
  { id: WS2, organization_id: ORG, name: 'research', settings_json: {}, created_at: NOW },
]

export function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: MEM1,
    organization_id: ORG,
    workspace_id: WS1,
    project_id: null,
    agent_id: null,
    layer: 3,
    type: 'rule',
    scope_type: 'workspace',
    scope_id: WS1,
    title: 'Run migrations before tests',
    content: 'Always run `make migrate` before the integration test suite.',
    status: 'active',
    review_state: 'none',
    confidence: 0.8,
    trust_score: 0.7,
    importance: 0.6,
    utility_score: 0.55,
    valid_from: NOW,
    valid_until: null,
    version: 3,
    metadata_json: {},
    retrieval_count: 4,
    last_retrieved_at: NOW,
    created_by_type: 'worker',
    created_by_id: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }
}

export const evidence: Evidence[] = [
  {
    id: 'ev-1',
    source_type: 'experience',
    source_id: EXP1,
    relation: 'derived_from',
    weight: 1,
    excerpt: 'Tests failed with missing table; running migrations fixed it.',
    created_at: NOW,
    source: {
      task: 'Run the integration tests',
      outcome: 'success',
      observation: 'relation "memories" does not exist',
      action: 'ran make migrate',
      result: 'all tests passed',
      source: 'agent',
    },
  },
]

export const history: MemoryVersion[] = [
  {
    id: 'v-1',
    version: 1,
    snapshot_json: { title: 'Run migrations', status: 'candidate', confidence: 0.6 },
    change_reason: 'extracted from experience',
    actor_type: 'worker',
    actor_id: 'extractor',
    created_at: NOW,
  },
  {
    id: 'v-2',
    version: 2,
    snapshot_json: { title: 'Run migrations', status: 'active', confidence: 0.6 },
    change_reason: 'promoted by validation',
    actor_type: 'worker',
    actor_id: 'validator',
    created_at: NOW,
  },
  {
    id: 'v-3',
    version: 3,
    snapshot_json: { title: 'Run migrations before tests', status: 'active', confidence: 0.8 },
    change_reason: 'manual edit',
    actor_type: 'api_key',
    actor_id: 'key-admin',
    created_at: NOW,
  },
]

export const relations: MemoryRelation[] = [
  {
    id: 'rel-1',
    relation: 'supersedes',
    direction: 'outgoing',
    other: { id: MEM2, title: 'Tests need a database', status: 'superseded', type: 'lesson' },
    metadata: {},
    created_at: NOW,
  },
]

export const usage: MemoryUsage[] = [
  {
    trace_id: 'tr-1',
    kind: 'context',
    query: 'how to run tests',
    rank: 1,
    score: 0.91,
    agent_id: null,
    created_at: NOW,
  },
]

export const feedback: Feedback[] = [
  {
    id: 'fb-1',
    memory_id: MEM1,
    value: 'helpful',
    note: 'saved a debugging session',
    agent_id: null,
    task_id: null,
    retrieval_trace_id: null,
    created_at: NOW,
  },
]

export function experience(overrides: Partial<Experience> = {}): Experience {
  return {
    id: EXP1,
    workspace_id: WS1,
    project_id: null,
    agent_id: null,
    session_id: null,
    task_id: null,
    episode_id: null,
    task: 'Run the integration tests',
    observation: 'relation does not exist',
    action: 'ran make migrate',
    result: 'tests passed',
    outcome: 'success',
    importance: 0.5,
    confidence: 0.7,
    source: 'agent',
    source_trust: 0.6,
    metadata_json: {},
    processing_status: 'pending',
    processed_at: null,
    created_at: NOW,
    ...overrides,
  }
}

export function conflict(overrides: Partial<ConflictDetail> = {}): ConflictDetail {
  const base: Conflict = {
    id: '0192f0a0-0000-7000-8000-00000000d001',
    workspace_id: WS1,
    candidate_memory_id: MEM2,
    existing_memory_id: MEM1,
    conflict_type: 'negation',
    status: 'open',
    analysis_json: {
      similarity: 0.91,
      judgment: { relation: 'contradicts', rationale: 'opposite instructions' },
    },
    resolution_json: {},
    created_at: NOW,
    resolved_at: null,
  }
  return {
    ...base,
    candidate: memory({ id: MEM2, title: 'Never run migrations in tests', status: 'disputed', version: 1 }),
    existing: memory(),
    ...overrides,
  }
}

export const stats: Stats = {
  workspace_id: WS1,
  memories_by_status: { active: 12, candidate: 3, archived: 1 },
  memories_by_type: { rule: 5, fact: 7 },
  memories_by_layer: { '3': 11, '4': 1 },
  pending_review: 2,
  experiences_by_outcome: { success: 8, failure: 3 },
  conflicts_by_status: { open: 1, resolved: 4 },
  dreams_by_status: { succeeded: 2 },
  jobs_by_status: { succeeded: 20, dead: 1 },
  feedback_by_value: { helpful: 5 },
  retrieval_24h: { count: 42, avg_latency_ms: 18.5, avg_context_tokens: 640 },
}

/** Endpoints every authenticated screen needs (identity + workspace list). */
export function withSession(api: MockApi, role: Role = 'admin'): MockApi {
  return api.get('/v1/me', { body: me(role) }).get('/v1/workspaces', { body: workspaces })
}

export function page<T>(items: T[], next_cursor: string | null = null) {
  return { body: { items, next_cursor } }
}
