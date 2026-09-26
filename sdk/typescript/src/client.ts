/**
 * Mnemos API client.
 *
 * Retry policy (mirrors the Python SDK):
 * - Transient failures (network errors, per-attempt timeouts, HTTP 429/502/503/504) are retried with exponential
 *   backoff; HTTP 429 honours `Retry-After`.
 * - Reads (GET, and the read-only POSTs `context`/`searchMemories`) are retried freely.
 * - POST writes always carry an `Idempotency-Key` (generated once per call unless supplied), so a retry is replayed by
 *   the server instead of being applied twice. A write without an idempotency key is never retried.
 * - PATCH (`updateMemory`) is never retried; it is guarded by `If-Match` optimistic concurrency instead.
 */

import { camelizeResponse, snakeizeRequest } from "./case.js";
import { errorFromResponse, MnemosConnectionError, MnemosError, MnemosTimeoutError } from "./errors.js";
import type {
  ContextInput,
  ContextResult,
  Dream,
  DreamInput,
  ExperienceCreated,
  ExperienceDetail,
  ExperienceInput,
  FeedbackInput,
  FeedbackResult,
  FetchLike,
  FetchResponseLike,
  Health,
  LearnedExperience,
  ListMemoriesInput,
  Me,
  Memory,
  MemoryChanges,
  MemoryEvidence,
  MemoryRelation,
  MemoryVersion,
  MnemosClientOptions,
  Page,
  RememberInput,
  SearchInput,
  SearchResult,
  WaitForLearningOptions,
  WorkspaceStats,
} from "./types.js";

export const SDK_VERSION = "0.1.0";

const RETRY_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type QueryValue = string | number | boolean | null | undefined | readonly (string | number | boolean)[];

export interface RequestOptions {
  /** Query-string parameters; `undefined`/`null` are skipped and arrays are repeated (`?status=a&status=b`). */
  query?: Record<string, QueryValue> | undefined;
  /** JSON body, sent as-is (callers of this low-level method are responsible for snake_case keys). */
  body?: unknown;
  headers?: Record<string, string> | undefined;
  /**
   * Allow retries. Even when true, a non-GET request is retried only if it carries an `Idempotency-Key` header or is
   * declared `readOnly`, and PATCH is never retried.
   */
  retry?: boolean | undefined;
  /** Declares a POST as side-effect free (e.g. retrieval), which makes it retryable without an idempotency key. */
  readOnly?: boolean | undefined;
  /** Convert response keys to camelCase (default true). */
  camelize?: boolean | undefined;
}

interface RawResponse {
  status: number;
  headers: FetchResponseLike["headers"];
  text: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** RFC 4122 v4 UUID. Uses Web Crypto when available (Node >= 19, browsers) and degrades gracefully elsewhere. */
export function randomId(): string {
  const c = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function path(template: string, id: string): string {
  if (id === "") throw new TypeError("id must be a non-empty string");
  return template.replace("{id}", encodeURIComponent(id));
}

export class MnemosClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly #apiKey: string | undefined;
  readonly #fetch: FetchLike;
  readonly #headers: Record<string, string>;

  constructor(options: MnemosClientOptions) {
    if (!options.baseUrl) throw new TypeError("MnemosClient: baseUrl is required");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = Math.max(0, options.maxRetries ?? 3);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 300);
    this.maxRetryDelayMs = Math.max(0, options.maxRetryDelayMs ?? 60_000);
    this.#headers = { ...(options.headers ?? {}) };
    if (options.fetch) {
      this.#fetch = options.fetch;
    } else {
      const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
      if (typeof globalFetch !== "function") {
        throw new TypeError("MnemosClient: no global fetch available (Node >= 18 required); pass options.fetch");
      }
      // Call through a wrapper so the global fetch is always invoked with the right `this`.
      this.#fetch = (url, init) => globalFetch.call(globalThis, url, init);
    }
  }

  // ============================================================================================ core ergonomics

  /** Retrieve a token-budgeted context block of relevant, trusted memories. Read-only; retried on transient errors. */
  context(input: ContextInput): Promise<ContextResult> {
    return this.request<ContextResult>("POST", "/v1/context", { body: snakeizeRequest({ ...input }), readOnly: true });
  }

  /** Record a task experience; the worker learns candidate memories from it asynchronously. */
  experience(input: ExperienceInput): Promise<ExperienceCreated> {
    const { idempotencyKey, ...body } = input;
    return this.#write<ExperienceCreated>("POST", "/v1/experiences", snakeizeRequest(body), idempotencyKey);
  }

  /** Hybrid search with a per-signal score breakdown. Read-only; retried on transient errors. */
  searchMemories(input: SearchInput): Promise<SearchResult> {
    return this.request<SearchResult>("POST", "/v1/memories/search", {
      body: snakeizeRequest({ ...input }),
      readOnly: true,
    });
  }

  getMemory(memoryId: string): Promise<Memory> {
    return this.request<Memory>("GET", path("/v1/memories/{id}", memoryId));
  }

  /** Report whether a retrieved memory helped; adjusts its utility/trust. */
  feedback(memoryId: string, input: FeedbackInput): Promise<FeedbackResult> {
    const { idempotencyKey, ...body } = input;
    return this.#write<FeedbackResult>(
      "POST",
      path("/v1/memories/{id}/feedback", memoryId),
      snakeizeRequest(body),
      idempotencyKey,
    );
  }

  /** Queue a dreaming (offline consolidation) run. Resolves with the queued run (HTTP 202). */
  dream(input: DreamInput): Promise<Dream> {
    const { idempotencyKey, ...body } = input;
    return this.#write<Dream>("POST", "/v1/dreams", snakeizeRequest(body), idempotencyKey);
  }

  // ============================================================================================ memories

  /**
   * Propose a memory. It is created as an untrusted `candidate` and only becomes retrievable after the validation
   * pipeline (or a reviewer) promotes it.
   */
  remember(input: RememberInput): Promise<Memory> {
    const { idempotencyKey, ...body } = input;
    return this.#write<Memory>("POST", "/v1/memories", snakeizeRequest(body), idempotencyKey);
  }

  /**
   * Update a memory with optimistic concurrency (`If-Match: "<expectedVersion>"`). Throws {@link ConflictError} with
   * `currentVersion` when the memory changed in the meantime. Never retried.
   */
  updateMemory(memoryId: string, expectedVersion: number, changes: MemoryChanges): Promise<Memory> {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new TypeError("expectedVersion must be a positive integer");
    }
    return this.request<Memory>("PATCH", path("/v1/memories/{id}", memoryId), {
      body: snakeizeRequest({ ...changes }),
      headers: { "If-Match": `"${String(expectedVersion)}"` },
      retry: false,
    });
  }

  listMemories(input: ListMemoriesInput = {}): Promise<Page<Memory>> {
    return this.request<Page<Memory>>("GET", "/v1/memories", {
      query: {
        workspace_id: input.workspaceId,
        status: input.status,
        type: input.type,
        scope_type: input.scopeType,
        project_id: input.projectId,
        layer: input.layer,
        review_state: input.reviewState,
        q: input.q,
        limit: input.limit,
        cursor: input.cursor,
      },
    });
  }

  memoryHistory(memoryId: string): Promise<MemoryVersion[]> {
    return this.request<MemoryVersion[]>("GET", path("/v1/memories/{id}/history", memoryId));
  }

  memoryEvidence(memoryId: string): Promise<MemoryEvidence[]> {
    return this.request<MemoryEvidence[]>("GET", path("/v1/memories/{id}/evidence", memoryId));
  }

  memoryRelations(memoryId: string): Promise<MemoryRelation[]> {
    return this.request<MemoryRelation[]>("GET", path("/v1/memories/{id}/relations", memoryId));
  }

  // ============================================================================================ experiences / dreams

  getExperience(experienceId: string): Promise<ExperienceDetail> {
    return this.request<ExperienceDetail>("GET", path("/v1/experiences/{id}", experienceId));
  }

  /**
   * Poll until the experience was processed and every memory learned from it left the pending-validation state
   * (it was promoted, rejected, disputed, or queued for human review). Resolves with full {@link Memory} objects in
   * `learning.memories`. Throws {@link MnemosTimeoutError} after `timeoutMs`, or a `learning_failed`
   * {@link MnemosError} if the extraction job is dead.
   */
  async waitForLearning(experienceId: string, options: WaitForLearningOptions = {}): Promise<LearnedExperience> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const pollIntervalMs = options.pollIntervalMs ?? 300;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const exp = await this.getExperience(experienceId);
      const learning = exp.learning;
      if (learning?.processingStatus === "processed") {
        const memories = await Promise.all(learning.memories.map((m) => this.getMemory(m.id)));
        if (memories.every((m) => m.status !== "candidate" || m.reviewState !== "none")) {
          return { ...exp, learning: { ...learning, memories } };
        }
      }
      if (learning?.jobStatus === "dead") {
        throw new MnemosError({
          status: 500,
          code: "learning_failed",
          message: `extraction job for experience ${experienceId} is dead`,
          details: { job_id: learning.jobId },
        });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new MnemosTimeoutError({
          status: 0,
          code: "timeout",
          message: `learning for experience ${experienceId} not finished after ${String(timeoutMs)}ms`,
        });
      }
      await sleep(Math.min(pollIntervalMs, remaining));
    }
  }

  getDream(dreamId: string): Promise<Dream> {
    return this.request<Dream>("GET", path("/v1/dreams/{id}", dreamId));
  }

  // ============================================================================================ ops

  /** Workspace counters (memories by status/type/layer, pending review, jobs, dreams, retrieval latency). */
  stats(workspaceId: string): Promise<WorkspaceStats> {
    return this.request<WorkspaceStats>("GET", "/v1/stats", { query: { workspace_id: workspaceId } });
  }

  /** Readiness probe (`GET /health/ready`): database, pgvector, queue, redis, workers and providers. */
  health(): Promise<Health> {
    return this.request<Health>("GET", "/health/ready");
  }

  /** The calling API key's organization, role, permissions and workspace scope. */
  me(): Promise<Me> {
    return this.request<Me>("GET", "/v1/me");
  }

  // ============================================================================================ transport

  #write<T>(method: HttpMethod, urlPath: string, body: unknown, idempotencyKey: string | undefined): Promise<T> {
    // Generated once per logical call, so every retry of this call carries the same key.
    const key = idempotencyKey ?? `sdk-${randomId()}`;
    return this.request<T>(method, urlPath, { body, headers: { "Idempotency-Key": key } });
  }

  /**
   * Low-level request with auth, timeout, retry and error mapping. Response keys are camelCased unless
   * `camelize: false`. Throws a {@link MnemosError} subclass for every failure.
   */
  async request<T = unknown>(method: HttpMethod, urlPath: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", ...this.#headers };
    if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;
    Object.assign(headers, options.headers ?? {});
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const safeToRepeat =
      method === "GET" || options.readOnly === true || (method !== "PATCH" && hasHeader(headers, "Idempotency-Key"));
    const retry = (options.retry ?? true) && safeToRepeat;
    const attempts = retry ? this.maxRetries + 1 : 1;
    const url = this.#url(urlPath, options.query);

    for (let attempt = 0; ; attempt++) {
      const last = attempt >= attempts - 1;
      let res: RawResponse;
      try {
        res = await this.#attempt(url, method, headers, body);
      } catch (err) {
        if (last) throw err;
        await sleep(this.#backoff(attempt));
        continue;
      }

      const retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : undefined;
      if (RETRY_STATUS.has(res.status) && !last) {
        const delay = retryAfterMs ?? this.#backoff(attempt);
        if (delay <= this.maxRetryDelayMs) {
          await sleep(delay);
          continue;
        }
      }
      if (res.status >= 400) throw errorFromResponse(res.status, res.text, res.headers, retryAfterMs);
      if (res.text === "") return undefined as T;
      let data: unknown;
      try {
        data = JSON.parse(res.text);
      } catch (err) {
        throw new MnemosError({
          status: res.status,
          code: "invalid_response",
          message: "response body is not valid JSON",
          cause: err,
        });
      }
      return (options.camelize === false ? data : camelizeResponse(data)) as T;
    }
  }

  async #attempt(url: string, method: string, headers: Record<string, string>, body: string | undefined): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      const init = { method, headers, signal: controller.signal, ...(body === undefined ? {} : { body }) };
      const res = await this.#fetch(url, init);
      // Read the body inside the timeout window too: a stalled body is as dead as a stalled connect.
      const text = await res.text();
      return { status: res.status, headers: res.headers, text };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new MnemosTimeoutError({
          status: 0,
          code: "timeout",
          message: `${method} ${url} timed out after ${String(this.timeoutMs)}ms`,
          cause: err,
        });
      }
      throw new MnemosConnectionError({
        status: 0,
        code: "connection_error",
        message: `${method} ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  #backoff(attempt: number): number {
    return Math.min(this.retryBaseDelayMs * 2 ** attempt, this.maxRetryDelayMs);
  }

  #url(urlPath: string, query: Record<string, QueryValue> | undefined): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      const values: readonly (string | number | boolean)[] = Array.isArray(value)
        ? (value as readonly (string | number | boolean)[])
        : [value as string | number | boolean];
      for (const v of values) params.append(key, String(v));
    }
    const qs = params.toString();
    return `${this.baseUrl}${urlPath}${qs ? `?${qs}` : ""}`;
  }
}
