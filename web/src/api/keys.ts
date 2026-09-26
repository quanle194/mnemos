import type { MemoryListParams, UUID } from './types'

/** Query-key factory. Prefix keys (e.g. `qk.memories.all`) invalidate everything below them. */
export const qk = {
  me: ['me'] as const,
  workspaces: ['workspaces'] as const,
  projects: (ws: UUID) => ['projects', ws] as const,
  agents: (ws: UUID) => ['agents', ws] as const,
  apiKeys: ['api-keys'] as const,
  memories: {
    all: ['memories'] as const,
    list: (params: MemoryListParams) => ['memories', 'list', params] as const,
    detail: (id: UUID) => ['memories', 'detail', id] as const,
    evidence: (id: UUID) => ['memories', 'detail', id, 'evidence'] as const,
    history: (id: UUID) => ['memories', 'detail', id, 'history'] as const,
    relations: (id: UUID) => ['memories', 'detail', id, 'relations'] as const,
    usage: (id: UUID) => ['memories', 'detail', id, 'usage'] as const,
    feedback: (id: UUID) => ['memories', 'detail', id, 'feedback'] as const,
  },
  experiences: {
    all: ['experiences'] as const,
    list: (ws: UUID, outcome?: string) => ['experiences', 'list', ws, outcome ?? ''] as const,
    detail: (id: UUID) => ['experiences', 'detail', id] as const,
  },
  episodes: {
    all: ['episodes'] as const,
    list: (ws: UUID) => ['episodes', 'list', ws] as const,
    detail: (id: UUID) => ['episodes', 'detail', id] as const,
  },
  dreams: {
    all: ['dreams'] as const,
    list: (ws: UUID) => ['dreams', 'list', ws] as const,
    detail: (id: UUID) => ['dreams', 'detail', id] as const,
  },
  conflicts: {
    all: ['conflicts'] as const,
    list: (ws: UUID, status?: string) => ['conflicts', 'list', ws, status ?? ''] as const,
    detail: (id: UUID) => ['conflicts', 'detail', id] as const,
  },
  stats: (ws: UUID) => ['stats', ws] as const,
  graph: (ws: UUID, includeInactive: boolean) => ['graph', ws, includeInactive] as const,
  audit: (ws: UUID) => ['audit', ws] as const,
  jobs: (ws: UUID, status?: string) => ['jobs', ws, status ?? ''] as const,
  traces: {
    all: ['traces'] as const,
    list: (ws: UUID) => ['traces', 'list', ws] as const,
    detail: (id: UUID) => ['traces', 'detail', id] as const,
  },
  evals: (ws: UUID | null) => ['evals', ws ?? 'all'] as const,
  readiness: ['readiness'] as const,
}
