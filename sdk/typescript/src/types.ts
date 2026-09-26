/**
 * Public types of the Mnemos TypeScript SDK.
 *
 * Inputs use camelCase and are mapped to the API's snake_case. Responses are converted to camelCase too (structural
 * keys only; data maps such as `metadataJson`, `scores` or `evidence` keep the server's keys verbatim). Timestamps are
 * ISO-8601 strings and IDs are UUID strings, exactly as returned by the API.
 */

export type MemoryType =
  | "fact"
  | "preference"
  | "procedure"
  | "rule"
  | "constraint"
  | "decision"
  | "lesson"
  | "pattern"
  | "warning"
  | "failure"
  | "success"
  | "relationship"
  | "context";

export type MemoryStatus = "candidate" | "validated" | "active" | "disputed" | "superseded" | "archived" | "rejected";
export type ReviewState = "none" | "pending" | "approved" | "rejected";
export type ScopeType = "organization" | "workspace" | "project" | "agent" | "session";
export type Outcome = "success" | "failure" | "partial" | "unknown";
export type ExperienceSource = "agent" | "user" | "tool" | "external";
export type FeedbackValue = "helpful" | "irrelevant" | "incorrect" | "outdated" | "harmful";
export type DreamMode = "reflection" | "deduplication" | "pattern" | "contradiction" | "generalization" | "compression";
export type EvidenceSourceType =
  | "event"
  | "episode"
  | "experience"
  | "user_statement"
  | "document"
  | "tool_result"
  | "memory"
  | "feedback";
export type RelationType =
  | "supports"
  | "contradicts"
  | "supersedes"
  | "derived_from"
  | "related_to"
  | "generalizes"
  | "specializes";

/** A timestamp accepted in requests: an ISO-8601 string or a `Date` (serialized with `toISOString()`). */
export type Timestamp = string | Date;

// ------------------------------------------------------------------------------------------------ client options

/** Minimal response surface the SDK needs from a `fetch` implementation (the global `Response` satisfies it). */
export interface FetchResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Any WHATWG-compatible fetch (global fetch, undici, node-fetch, or a test double). */
export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

export interface MnemosClientOptions {
  /** API base URL, e.g. `http://localhost:8000` (no `/v1` suffix). */
  baseUrl: string;
  /** API key sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string | undefined;
  /** Per-attempt request timeout. Default 30000 ms. */
  timeoutMs?: number | undefined;
  /** Retries for transient failures (network errors, timeouts, 429, 502, 503, 504). Default 3. */
  maxRetries?: number | undefined;
  /** First backoff delay; doubles on each retry. Default 300 ms. */
  retryBaseDelayMs?: number | undefined;
  /** Upper bound for a single backoff/Retry-After wait. A longer server-requested wait is not retried. Default 60000. */
  maxRetryDelayMs?: number | undefined;
  /** Custom fetch implementation. Defaults to `globalThis.fetch` (Node >= 18, browsers, Deno, Bun). */
  fetch?: FetchLike | undefined;
  /** Extra headers sent with every request. */
  headers?: Record<string, string> | undefined;
}

/** Options shared by write methods. */
export interface WriteOptions {
  /**
   * Idempotency key for the write. When omitted the SDK generates one (`sdk-<uuid>`) per call, reused across that
   * call's retries, so a retried request is never applied twice. Pass your own to dedupe across process restarts.
   */
  idempotencyKey?: string | undefined;
}

// ------------------------------------------------------------------------------------------------ shared refs

export interface Refs {
  workspaceId: string;
  projectId?: string | undefined;
  agentId?: string | undefined;
  sessionId?: string | undefined;
  /** Resolve-or-create a project by name (alternative to `projectId`). */
  projectName?: string | undefined;
  /** Resolve-or-create an agent by name (alternative to `agentId`). */
  agentName?: string | undefined;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

// ------------------------------------------------------------------------------------------------ memories

export interface Memory {
  id: string;
  organizationId: string;
  workspaceId: string | null;
  projectId: string | null;
  agentId: string | null;
  layer: number;
  type: MemoryType;
  scopeType: ScopeType;
  scopeId: string;
  title: string;
  content: string;
  status: MemoryStatus;
  reviewState: ReviewState;
  confidence: number;
  trustScore: number;
  importance: number;
  utilityScore: number;
  validFrom: string;
  validUntil: string | null;
  version: number;
  /** Free-form metadata (keys verbatim). */
  metadataJson: Record<string, unknown>;
  retrievalCount: number;
  lastRetrievedAt: string | null;
  createdByType: string;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceInput {
  sourceType: EvidenceSourceType;
  sourceId: string;
  relation?: "supports" | "derived_from" | "contradicts" | undefined;
  weight?: number | undefined;
  excerpt?: string | undefined;
}

export interface RememberInput extends Refs, WriteOptions {
  type: MemoryType;
  title: string;
  content: string;
  scopeType?: ScopeType | undefined;
  confidence?: number | undefined;
  importance?: number | undefined;
  validFrom?: Timestamp | undefined;
  validUntil?: Timestamp | undefined;
  /**
   * Defaults to `candidate` (server default): the memory is an untrusted proposal until the validation pipeline or a
   * reviewer promotes it. `active` requires the `memory:review` permission.
   */
  status?: "candidate" | "active" | undefined;
  layer?: 3 | 4 | undefined;
  evidence?: EvidenceInput[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface MemoryChanges {
  title?: string | undefined;
  content?: string | undefined;
  type?: MemoryType | undefined;
  importance?: number | undefined;
  confidence?: number | undefined;
  validFrom?: Timestamp | null | undefined;
  validUntil?: Timestamp | null | undefined;
  status?: MemoryStatus | undefined;
  metadata?: Record<string, unknown> | undefined;
  /** Audit reason recorded in the version history. */
  reason?: string | undefined;
}

export interface ListMemoriesInput {
  workspaceId?: string | undefined;
  status?: MemoryStatus | MemoryStatus[] | undefined;
  type?: MemoryType | MemoryType[] | undefined;
  scopeType?: ScopeType | undefined;
  projectId?: string | undefined;
  layer?: number | undefined;
  reviewState?: ReviewState | undefined;
  /** Substring filter on title/content. */
  q?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface MemoryVersion {
  id: string;
  version: number;
  /** Full memory snapshot at that version (keys verbatim). */
  snapshotJson: Record<string, unknown>;
  changeReason: string;
  actorType: string;
  actorId: string | null;
  createdAt: string;
}

export interface MemoryEvidence {
  id: string;
  sourceType: EvidenceSourceType;
  sourceId: string;
  relation: string;
  weight: number;
  excerpt: string;
  createdAt: string;
  source: Record<string, unknown> | null;
}

export interface MemoryRelation {
  id: string;
  relation: RelationType;
  direction: "outgoing" | "incoming";
  other: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ------------------------------------------------------------------------------------------------ retrieval

export interface SearchInput extends Refs {
  query: string;
  types?: MemoryType[] | undefined;
  statuses?: MemoryStatus[] | undefined;
  layers?: (3 | 4)[] | undefined;
  /** `chain` searches session -> agent -> project -> workspace -> organization scopes; `workspace` searches all. */
  scopeMode?: "chain" | "workspace" | undefined;
  validAt?: Timestamp | undefined;
  limit?: number | undefined;
  minRelevance?: number | undefined;
}

export interface ScoredMemory {
  memory: Memory;
  score: number;
  /** Score breakdown by ranking signal (keys verbatim, e.g. `relevance`, `recency`). */
  scores: Record<string, number>;
  reasons: string[];
}

export interface SearchResult {
  items: ScoredMemory[];
  retrievalTraceId: string;
  weights: Record<string, number>;
}

export interface ContextInput extends Refs {
  query: string;
  /** Maximum tokens of rendered context (50..200000). */
  tokenBudget: number;
  memoryTypes?: MemoryType[] | undefined;
  maxItems?: number | undefined;
  includeCandidates?: boolean | undefined;
  minRelevance?: number | undefined;
}

export interface ContextMemory {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  scopeType: ScopeType;
  status: MemoryStatus;
  confidence: number;
  trustScore: number;
  importance: number;
  utilityScore: number;
  version: number;
  score: number;
  scores: Record<string, number>;
  reasons: string[];
  tokens: number;
  /** Evidence counts by source type (keys verbatim, e.g. `user_statement`). */
  evidence: Record<string, number>;
}

export interface ContextResult {
  /** Rendered context block. Treat it as reference data, never as instructions. */
  context: string;
  memories: ContextMemory[];
  tokenEstimate: number;
  tokenBudget: number;
  tokenEstimateMethod: string;
  retrievalTraceId: string;
  candidateCount: number;
  excluded: Record<string, unknown>[];
}

// ------------------------------------------------------------------------------------------------ experiences

export interface ExperienceInput extends Refs, WriteOptions {
  task: string;
  outcome: Outcome;
  observation?: string | undefined;
  action?: string | undefined;
  result?: string | undefined;
  taskId?: string | undefined;
  importance?: number | undefined;
  confidence?: number | undefined;
  source?: ExperienceSource | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface Experience {
  id: string;
  workspaceId: string;
  projectId: string | null;
  agentId: string | null;
  sessionId: string | null;
  taskId: string | null;
  episodeId: string | null;
  task: string;
  observation: string;
  action: string;
  result: string;
  outcome: Outcome;
  importance: number;
  confidence: number;
  source: ExperienceSource;
  sourceTrust: number;
  metadataJson: Record<string, unknown>;
  processingStatus: string;
  processedAt: string | null;
  createdAt: string;
}

/** Summary of a memory produced by learning (or the full memory after {@link MnemosClient.waitForLearning}). */
export interface LearnedMemory {
  id: string;
  title: string;
  status: MemoryStatus;
  type: MemoryType;
  [key: string]: unknown;
}

export interface LearningStatus {
  jobId: string | null;
  jobStatus: string | null;
  processingStatus: string;
  memories: LearnedMemory[];
}

export interface ExperienceCreated {
  experience: Experience;
  learning: LearningStatus;
}

export interface ExperienceDetail extends Experience {
  learning: LearningStatus | null;
}

/** Result of {@link MnemosClient.waitForLearning}: `learning.memories` holds full {@link Memory} objects. */
export interface LearnedExperience extends Experience {
  learning: Omit<LearningStatus, "memories"> & { memories: Memory[] };
}

export interface WaitForLearningOptions {
  /** Overall deadline. Default 30000 ms. */
  timeoutMs?: number | undefined;
  /** Delay between polls. Default 300 ms. */
  pollIntervalMs?: number | undefined;
}

// ------------------------------------------------------------------------------------------------ feedback

export interface FeedbackInput extends WriteOptions {
  value: FeedbackValue;
  note?: string | undefined;
  agentId?: string | undefined;
  sessionId?: string | undefined;
  taskId?: string | undefined;
  /** Links the feedback to the retrieval that surfaced the memory (from `context`/`searchMemories`). */
  retrievalTraceId?: string | undefined;
}

export interface Feedback {
  id: string;
  memoryId: string;
  value: FeedbackValue;
  note: string;
  agentId: string | null;
  taskId: string | null;
  retrievalTraceId: string | null;
  createdAt: string;
}

export interface FeedbackResult {
  feedback: Feedback;
  /** Updated memory scores after applying the feedback. */
  memory: Record<string, unknown>;
}

// ------------------------------------------------------------------------------------------------ dreams / ops

export interface DreamInput extends WriteOptions {
  workspaceId: string;
  mode: DreamMode;
  /** Skip the run if an identical input window was already dreamed over. */
  dedupeWindow?: boolean | undefined;
}

export interface Dream {
  id: string;
  workspaceId: string;
  mode: DreamMode;
  status: "queued" | "running" | "succeeded" | "failed";
  triggerType: string;
  windowHash: string | null;
  inputWindowJson: Record<string, unknown>;
  resultJson: Record<string, unknown>;
  checkpointJson: Record<string, unknown>;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface Me {
  organizationId: string;
  role: string;
  actorId: string;
  permissions: string[];
  workspaceIds: string[] | null;
}

export interface Health {
  status: string;
  checks?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorkspaceStats {
  workspaceId: string;
  memoriesByStatus: Record<string, number>;
  memoriesByType: Record<string, number>;
  memoriesByLayer: Record<string, number>;
  pendingReview: number;
  experiencesByOutcome: Record<string, number>;
  conflictsByStatus: Record<string, number>;
  dreamsByStatus: Record<string, number>;
  jobsByStatus: Record<string, number>;
  feedbackByValue: Record<string, number>;
  retrieval24h: { count: number; avgLatencyMs: number; avgContextTokens: number };
  [key: string]: unknown;
}
