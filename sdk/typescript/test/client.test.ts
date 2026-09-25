import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuthError,
  ConflictError,
  MnemosClient,
  MnemosConnectionError,
  MnemosError,
  MnemosTimeoutError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from "../src/index.js";
import type { FetchLike } from "../src/index.js";
import { AGENT, apiError, EXP, experienceJson, json, MEM, memoryJson, scriptedFetch, WS } from "./helpers.js";

const IDEMPOTENCY_KEY = /^sdk-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function client(fetch: FetchLike, extra: Partial<ConstructorParameters<typeof MnemosClient>[0]> = {}) {
  return new MnemosClient({
    baseUrl: "http://mnemos.test/",
    apiKey: "mk_test_secret",
    fetch,
    retryBaseDelayMs: 1,
    ...extra,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("request mapping", () => {
  it("context maps camelCase input to snake_case and camelizes the response", async () => {
    const f = scriptedFetch(
      json(200, {
        context: "## Relevant memories\n- Retry flaky uploads",
        memories: [
          {
            id: MEM,
            type: "lesson",
            title: "Retry flaky uploads",
            content: "Uploads need retries.",
            scope_type: "project",
            status: "active",
            confidence: 0.8,
            trust_score: 0.7,
            importance: 0.5,
            utility_score: 0.6,
            version: 3,
            score: 0.9,
            scores: { relevance: 0.95, trust_score: 0.7 },
            reasons: ["semantic match"],
            tokens: 12,
            evidence: { user_statement: 1, tool_result: 2 },
          },
        ],
        token_estimate: 40,
        token_budget: 3000,
        token_estimate_method: "chars/4 heuristic",
        retrieval_trace_id: "trace-1",
        candidate_count: 4,
        excluded: [{ memory_id: "x", reason: "over_budget" }],
      }),
    );
    const c = client(f.fetch);
    const query = "how do I upload?";
    const workspaceId = WS;

    const context = await c.context({ workspaceId, query, tokenBudget: 3000 });

    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe("http://mnemos.test/v1/context");
    expect(f.calls[0]?.init.method).toBe("POST");
    expect(f.body(0)).toEqual({ workspace_id: WS, query, token_budget: 3000 });
    expect(f.header(0, "Authorization")).toBe("Bearer mk_test_secret");
    expect(f.header(0, "Content-Type")).toBe("application/json");
    // read-only retrieval: no idempotency key needed
    expect(f.header(0, "Idempotency-Key")).toBeUndefined();

    expect(context.retrievalTraceId).toBe("trace-1");
    expect(context.tokenEstimate).toBe(40);
    expect(context.candidateCount).toBe(4);
    expect(context.memories[0]?.trustScore).toBe(0.7);
    expect(context.memories[0]?.scopeType).toBe("project");
    // data maps keep the server's keys verbatim
    expect(context.memories[0]?.evidence).toEqual({ user_statement: 1, tool_result: 2 });
    expect(context.memories[0]?.scores).toEqual({ relevance: 0.95, trust_score: 0.7 });
    expect(context.excluded[0]).toEqual({ memoryId: "x", reason: "over_budget" });
  });

  it("context passes optional scoping fields", async () => {
    const f = scriptedFetch(json(200, { context: "", memories: [] }));
    await client(f.fetch).context({
      workspaceId: WS,
      query: "q",
      tokenBudget: 500,
      projectId: "p",
      agentId: AGENT,
      sessionId: "s",
      memoryTypes: ["lesson", "warning"],
      maxItems: 5,
      includeCandidates: false,
      minRelevance: 0.3,
    });
    expect(f.body(0)).toEqual({
      workspace_id: WS,
      query: "q",
      token_budget: 500,
      project_id: "p",
      agent_id: AGENT,
      session_id: "s",
      memory_types: ["lesson", "warning"],
      max_items: 5,
      include_candidates: false,
      min_relevance: 0.3,
    });
  });

  it("experience supports the spec usage, sends an idempotency key and keeps metadata keys verbatim", async () => {
    const created201 = () =>
      json(201, {
        experience: experienceJson(null),
        learning: { job_id: "job-1", job_status: "queued", processing_status: "pending", memories: [] },
      });
    const f = scriptedFetch(created201(), created201());
    const c = client(f.fetch);
    const workspaceId = WS;
    const agentId = AGENT;
    const task = "deploy service";
    const observation = "health check failed";
    const result = "rolled back";

    // exact usage from docs/03-api-sdk-mcp.md
    const created = await c.experience({ workspaceId, agentId, task, observation, result, outcome: "success" });
    await c.experience({ workspaceId, task, outcome: "failure", metadata: { customerId: 7, snake_key: { innerKey: 1 } } });

    expect(f.calls[0]?.url).toBe("http://mnemos.test/v1/experiences");
    expect(f.body(0)).toEqual({
      workspace_id: WS,
      agent_id: AGENT,
      task,
      observation,
      result,
      outcome: "success",
    });
    expect(f.header(0, "Idempotency-Key")).toMatch(IDEMPOTENCY_KEY);
    expect(f.body(1)).toEqual({
      workspace_id: WS,
      task,
      outcome: "failure",
      metadata: { customerId: 7, snake_key: { innerKey: 1 } },
    });
    // a fresh key per logical call
    expect(f.header(1, "Idempotency-Key")).not.toBe(f.header(0, "Idempotency-Key"));

    expect(created.experience.id).toBe(EXP);
    expect(created.experience.sourceTrust).toBe(0.6);
    expect(created.learning.jobStatus).toBe("queued");
    expect(created.learning.processingStatus).toBe("pending");
  });

  it("uses a caller-supplied idempotency key and never puts it in the body", async () => {
    const f = scriptedFetch(json(201, { experience: experienceJson(null), learning: null }));
    await client(f.fetch).experience({ workspaceId: WS, task: "t", outcome: "unknown", idempotencyKey: "run-42" });
    expect(f.header(0, "Idempotency-Key")).toBe("run-42");
    expect(f.body(0)).not.toHaveProperty("idempotency_key");
    expect(f.body(0)).not.toHaveProperty("idempotencyKey");
  });

  it("searchMemories maps filters and camelizes nested memories", async () => {
    const f = scriptedFetch(
      json(200, {
        items: [{ memory: memoryJson(), score: 0.8, scores: { relevance: 0.9 }, reasons: ["r"] }],
        retrieval_trace_id: "t-9",
        weights: { relevance: 0.5, trust_score: 0.2 },
      }),
    );
    const res = await client(f.fetch).searchMemories({
      workspaceId: WS,
      query: "uploads",
      types: ["lesson"],
      statuses: ["active"],
      scopeMode: "workspace",
      validAt: new Date("2026-02-01T00:00:00Z"),
      limit: 5,
      minRelevance: 0.1,
    });
    expect(f.calls[0]?.url).toBe("http://mnemos.test/v1/memories/search");
    expect(f.body(0)).toEqual({
      workspace_id: WS,
      query: "uploads",
      types: ["lesson"],
      statuses: ["active"],
      scope_mode: "workspace",
      valid_at: "2026-02-01T00:00:00.000Z",
      limit: 5,
      min_relevance: 0.1,
    });
    const item = res.items[0];
    expect(item?.memory.trustScore).toBe(0.7);
    expect(item?.memory.reviewState).toBe("none");
    expect(item?.memory.metadataJson).toEqual({ source_system: "ci", nested_key: { inner_key: 1 } });
    expect(res.retrievalTraceId).toBe("t-9");
    expect(res.weights).toEqual({ relevance: 0.5, trust_score: 0.2 });
  });

  it("getMemory, history, evidence and relations hit the right paths", async () => {
    const f = scriptedFetch(
      json(200, memoryJson()),
      json(200, [
        {
          id: "v1",
          version: 1,
          snapshot_json: { trust_score: 0.5 },
          change_reason: "created",
          actor_type: "agent",
          actor_id: null,
          created_at: "x",
        },
      ]),
      json(200, [
        {
          id: "e1",
          source_type: "experience",
          source_id: EXP,
          relation: "supports",
          weight: 1,
          excerpt: "",
          created_at: "x",
          source: { task_id: "t" },
        },
      ]),
      json(200, [
        {
          id: "r1",
          relation: "supports",
          direction: "outgoing",
          other: { memory_id: "m2", title: "x" },
          metadata: { some_key: 1 },
          created_at: "x",
        },
      ]),
    );
    const c = client(f.fetch);
    const mem = await c.getMemory(MEM);
    const history = await c.memoryHistory(MEM);
    const evidence = await c.memoryEvidence(MEM);
    const relations = await c.memoryRelations(MEM);
    expect(f.calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      `GET http://mnemos.test/v1/memories/${MEM}`,
      `GET http://mnemos.test/v1/memories/${MEM}/history`,
      `GET http://mnemos.test/v1/memories/${MEM}/evidence`,
      `GET http://mnemos.test/v1/memories/${MEM}/relations`,
    ]);
    expect(f.calls[0]?.init.body).toBeUndefined();
    expect(mem.utilityScore).toBe(0.6);
    expect(history[0]?.snapshotJson).toEqual({ trust_score: 0.5 });
    expect(history[0]?.changeReason).toBe("created");
    expect(evidence[0]?.sourceType).toBe("experience");
    expect(evidence[0]?.source).toEqual({ taskId: "t" });
    expect(relations[0]?.other).toEqual({ memoryId: "m2", title: "x" });
    expect(relations[0]?.metadata).toEqual({ some_key: 1 });
  });

  it("encodes path ids", async () => {
    const f = scriptedFetch(json(200, memoryJson()));
    await client(f.fetch).getMemory("a/b?c");
    expect(f.calls[0]?.url).toBe("http://mnemos.test/v1/memories/a%2Fb%3Fc");
  });

  it("remember proposes a candidate (no status sent unless explicitly requested)", async () => {
    const f = scriptedFetch(json(201, memoryJson({ status: "candidate" })));
    const mem = await client(f.fetch).remember({
      workspaceId: WS,
      projectName: "billing",
      type: "fact",
      title: "Invoices are monthly",
      content: "Invoices are generated on the 1st.",
      evidence: [{ sourceType: "user_statement", sourceId: "u1", excerpt: "said so" }],
      metadata: { ticketId: "T-1" },
    });
    expect(f.calls[0]?.url).toBe("http://mnemos.test/v1/memories");
    expect(f.body(0)).toEqual({
      workspace_id: WS,
      project_name: "billing",
      type: "fact",
      title: "Invoices are monthly",
      content: "Invoices are generated on the 1st.",
      evidence: [{ source_type: "user_statement", source_id: "u1", excerpt: "said so" }],
      metadata: { ticketId: "T-1" },
    });
    expect(f.header(0, "Idempotency-Key")).toMatch(IDEMPOTENCY_KEY);
    expect(mem.status).toBe("candidate");
  });

  it("feedback and dream map their inputs", async () => {
    const f = scriptedFetch(
      json(201, {
        feedback: {
          id: "f1",
          memory_id: MEM,
          value: "helpful",
          note: "",
          agent_id: null,
          task_id: "t1",
          retrieval_trace_id: "tr",
          created_at: "x",
        },
        memory: { id: MEM, utility_score: 0.7 },
      }),
      json(202, {
        id: "d1",
        workspace_id: WS,
        mode: "reflection",
        status: "queued",
        trigger_type: "manual",
        window_hash: null,
        input_window_json: {},
        result_json: {},
        checkpoint_json: {},
        error: null,
        started_at: null,
        completed_at: null,
        created_at: "x",
      }),
      json(200, { id: "d1", status: "succeeded", result_json: { merged_count: 2 } }),
    );
    const c = client(f.fetch);
    const fb = await c.feedback(MEM, { value: "helpful", note: "", taskId: "t1", retrievalTraceId: "tr" });
    const dream = await c.dream({ workspaceId: WS, mode: "reflection" });
    const done = await c.getDream("d1");

    expect(f.calls[0]?.url).toBe(`http://mnemos.test/v1/memories/${MEM}/feedback`);
    expect(f.body(0)).toEqual({ value: "helpful", note: "", task_id: "t1", retrieval_trace_id: "tr" });
    expect(f.header(0, "Idempotency-Key")).toMatch(IDEMPOTENCY_KEY);
    expect(fb.feedback.retrievalTraceId).toBe("tr");
    expect(fb.memory).toEqual({ id: MEM, utilityScore: 0.7 });

    expect(f.calls[1]?.url).toBe("http://mnemos.test/v1/dreams");
    expect(f.body(1)).toEqual({ workspace_id: WS, mode: "reflection" });
    expect(f.header(1, "Idempotency-Key")).toMatch(IDEMPOTENCY_KEY);
    expect(dream.triggerType).toBe("manual");
    expect(dream.status).toBe("queued");
    expect(done.resultJson).toEqual({ merged_count: 2 });
  });

  it("updateMemory sends If-Match and snake_case changes without an idempotency key", async () => {
    const f = scriptedFetch(json(200, memoryJson({ version: 4, title: "New" })));
    const mem = await client(f.fetch).updateMemory(MEM, 3, {
      title: "New",
      validUntil: new Date("2027-01-01T00:00:00Z"),
      metadata: { reviewedBy: "ops" },
      reason: "fix typo",
    });
    expect(f.calls[0]?.init.method).toBe("PATCH");
    expect(f.header(0, "If-Match")).toBe('"3"');
    expect(f.header(0, "Idempotency-Key")).toBeUndefined();
    expect(f.body(0)).toEqual({
      title: "New",
      valid_until: "2027-01-01T00:00:00.000Z",
      metadata: { reviewedBy: "ops" },
      reason: "fix typo",
    });
    expect(mem.version).toBe(4);
    expect(() => client(f.fetch).updateMemory(MEM, 0, {})).toThrow(TypeError);
  });

  it("listMemories, stats, me and health use query strings and GET", async () => {
    const f = scriptedFetch(
      json(200, { items: [memoryJson()], next_cursor: "c2" }),
      json(200, {
        workspace_id: WS,
        memories_by_status: { active: 3, candidate: 1 },
        pending_review: 1,
        retrieval_24h: { count: 5, avg_latency_ms: 12.5, avg_context_tokens: 300 },
      }),
      json(200, { organization_id: "o", role: "agent", actor_id: "key:1", permissions: ["memory:read"], workspace_ids: null }),
      json(200, { status: "ok", checks: { database: { ok: true } } }),
    );
    const c = client(f.fetch);
    const page = await c.listMemories({ workspaceId: WS, projectId: "p1", status: ["active", "validated"], limit: 20 });
    const stats = await c.stats(WS);
    const me = await c.me();
    const health = await c.health();

    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/memories");
    expect(url.searchParams.get("workspace_id")).toBe(WS);
    expect(url.searchParams.get("project_id")).toBe("p1");
    expect(url.searchParams.getAll("status")).toEqual(["active", "validated"]);
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.has("cursor")).toBe(false);
    expect(page.nextCursor).toBe("c2");
    expect(page.items[0]?.id).toBe(MEM);

    expect(f.calls[1]?.url).toBe(`http://mnemos.test/v1/stats?workspace_id=${WS}`);
    expect(stats.memoriesByStatus).toEqual({ active: 3, candidate: 1 });
    expect(stats.pendingReview).toBe(1);
    expect(stats.retrieval24h.avgLatencyMs).toBe(12.5);

    expect(f.calls[2]?.url).toBe("http://mnemos.test/v1/me");
    expect(me.actorId).toBe("key:1");
    expect(me.workspaceIds).toBeNull();
    expect(f.calls[3]?.url).toBe("http://mnemos.test/health/ready");
    expect(health.status).toBe("ok");
  });

  it("omits the Authorization header without an API key and merges custom headers", async () => {
    const f = scriptedFetch(json(200, { status: "ok" }));
    await new MnemosClient({ baseUrl: "http://mnemos.test", fetch: f.fetch, headers: { "X-Trace": "1" } }).health();
    expect(f.header(0, "Authorization")).toBeUndefined();
    expect(f.header(0, "X-Trace")).toBe("1");
  });
});

describe("retries", () => {
  it("retries a 503 then succeeds (GET)", async () => {
    const f = scriptedFetch(apiError(503, "unavailable", "down"), json(200, memoryJson()));
    const mem = await client(f.fetch).getMemory(MEM);
    expect(f.calls).toHaveLength(2);
    expect(mem.id).toBe(MEM);
  });

  it("retries 502/504 and transient network errors", async () => {
    const f = scriptedFetch(
      apiError(502, "bad_gateway", "x"),
      new TypeError("fetch failed"),
      apiError(504, "timeout", "x"),
      json(200, memoryJson()),
    );
    await client(f.fetch).getMemory(MEM);
    expect(f.calls).toHaveLength(4);
  });

  it("keeps the same Idempotency-Key across retries of a write", async () => {
    const f = scriptedFetch(
      apiError(503, "unavailable", "down"),
      new TypeError("socket hang up"),
      json(201, { experience: experienceJson(null), learning: null }),
    );
    const res = await client(f.fetch).experience({ workspaceId: WS, task: "t", outcome: "success" });
    expect(f.calls).toHaveLength(3);
    const keys = [0, 1, 2].map((i) => f.header(i, "Idempotency-Key"));
    expect(keys[0]).toMatch(IDEMPOTENCY_KEY);
    expect(new Set(keys).size).toBe(1);
    expect(f.body(0)).toEqual(f.body(2));
    expect(res.experience.id).toBe(EXP);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const f = scriptedFetch(...Array.from({ length: 3 }, () => apiError(503, "unavailable", "still down")));
    const err = await client(f.fetch, { maxRetries: 2 }).getMemory(MEM).catch((e: unknown) => e);
    expect(f.calls).toHaveLength(3);
    expect(err).toBeInstanceOf(MnemosError);
    expect((err as MnemosError).status).toBe(503);
    expect((err as MnemosError).code).toBe("unavailable");
  });

  it("wraps exhausted network failures in MnemosConnectionError", async () => {
    const f = scriptedFetch(new TypeError("ECONNREFUSED"), new TypeError("ECONNREFUSED"));
    const err = await client(f.fetch, { maxRetries: 1 }).me().catch((e: unknown) => e);
    expect(f.calls).toHaveLength(2);
    expect(err).toBeInstanceOf(MnemosConnectionError);
    expect((err as MnemosConnectionError).status).toBe(0);
    expect((err as Error).cause).toBeInstanceOf(TypeError);
  });

  it("does not retry non-transient statuses such as 500 or 400", async () => {
    const f = scriptedFetch(apiError(500, "internal_error", "boom"));
    await expect(client(f.fetch).getMemory(MEM)).rejects.toMatchObject({ status: 500, code: "internal_error" });
    expect(f.calls).toHaveLength(1);
  });

  it("never retries PATCH, neither on 503 nor on network errors", async () => {
    const f1 = scriptedFetch(apiError(503, "unavailable", "down"), json(200, memoryJson()));
    await expect(client(f1.fetch).updateMemory(MEM, 3, { title: "x" })).rejects.toMatchObject({ status: 503 });
    expect(f1.calls).toHaveLength(1);

    const f2 = scriptedFetch(new TypeError("fetch failed"), json(200, memoryJson()));
    await expect(client(f2.fetch).updateMemory(MEM, 3, { title: "x" })).rejects.toBeInstanceOf(MnemosConnectionError);
    expect(f2.calls).toHaveLength(1);
  });

  it("never retries a low-level PATCH even when it carries an idempotency key", async () => {
    const f = scriptedFetch(apiError(503, "unavailable", "down"), json(200, memoryJson()));
    await expect(
      client(f.fetch).request("PATCH", `/v1/memories/${MEM}`, {
        body: { title: "x" },
        headers: { "If-Match": '"3"', "Idempotency-Key": "k" },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(f.calls).toHaveLength(1);
  });

  it("never retries an unsafe low-level write that has no idempotency key", async () => {
    const f = scriptedFetch(apiError(503, "unavailable", "down"), json(201, {}));
    await expect(client(f.fetch).request("POST", "/v1/memories/m/relations", { body: {} })).rejects.toMatchObject({
      status: 503,
    });
    expect(f.calls).toHaveLength(1);
  });

  it("honours Retry-After on 429", async () => {
    vi.useFakeTimers();
    const f = scriptedFetch(apiError(429, "rate_limited", "slow down", {}, { "Retry-After": "2" }), json(200, memoryJson()));
    const pending = client(f.fetch, { retryBaseDelayMs: 10 }).getMemory(MEM);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const mem = await pending;
    expect(f.calls).toHaveLength(2);
    expect(mem.id).toBe(MEM);
  });

  it("uses exponential backoff for 503", async () => {
    vi.useFakeTimers();
    const f = scriptedFetch(
      apiError(503, "unavailable", "x"),
      apiError(503, "unavailable", "x"),
      json(200, memoryJson()),
    );
    const pending = client(f.fetch, { retryBaseDelayMs: 100 }).getMemory(MEM);
    await vi.advanceTimersByTimeAsync(99);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(f.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(f.calls).toHaveLength(3);
  });

  it("throws RateLimitError without retrying when Retry-After exceeds maxRetryDelayMs", async () => {
    const f = scriptedFetch(apiError(429, "rate_limited", "slow down", {}, { "Retry-After": "60" }), json(200, {}));
    const err = await client(f.fetch, { maxRetryDelayMs: 1_000 }).me().catch((e: unknown) => e);
    expect(f.calls).toHaveLength(1);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(60_000);
  });

  it("times out a hung request and retries it", async () => {
    const hang = (init: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const f = scriptedFetch(hang, json(200, memoryJson()));
    const mem = await client(f.fetch, { timeoutMs: 20 }).getMemory(MEM);
    expect(f.calls).toHaveLength(2);
    expect(mem.id).toBe(MEM);

    const f2 = scriptedFetch(hang);
    const err = await client(f2.fetch, { timeoutMs: 20, maxRetries: 0 }).getMemory(MEM).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MnemosTimeoutError);
    expect((err as MnemosTimeoutError).code).toBe("timeout");
  });
});

describe("errors", () => {
  it("maps 409 to ConflictError with currentVersion", async () => {
    const f = scriptedFetch(
      apiError(409, "conflict", "version mismatch", { current_version: 5, expected_version: 3 }, { ETag: '"5"' }),
    );
    const err = await client(f.fetch).updateMemory(MEM, 3, { content: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toBeInstanceOf(MnemosError);
    const conflict = err as ConflictError;
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("conflict");
    expect(conflict.currentVersion).toBe(5);
    expect(conflict.details).toEqual({ current_version: 5, expected_version: 3 });
    expect(conflict.requestId).toBe("req-123");
    expect(conflict.message).toBe("[409 conflict] version mismatch");
    expect(conflict.name).toBe("ConflictError");
  });

  it("falls back to the ETag header for currentVersion", async () => {
    const f = scriptedFetch(apiError(409, "conflict", "stale", {}, { ETag: '"8"' }));
    const err = (await client(f.fetch).updateMemory(MEM, 3, {}).catch((e: unknown) => e)) as ConflictError;
    expect(err.currentVersion).toBe(8);
  });

  it("idempotency key reuse is a ConflictError without a version", async () => {
    const f = scriptedFetch(apiError(409, "idempotency_key_reused", "different request"));
    const err = (await client(f.fetch)
      .experience({ workspaceId: WS, task: "t", outcome: "success", idempotencyKey: "k" })
      .catch((e: unknown) => e)) as ConflictError;
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe("idempotency_key_reused");
    expect(err.currentVersion).toBeUndefined();
  });

  it.each([
    [401, "unauthorized", AuthError],
    [403, "forbidden", AuthError],
    [404, "not_found", NotFoundError],
    [422, "validation_error", ValidationError],
  ] as const)("maps %i to the typed error", async (status, code, cls) => {
    const f = scriptedFetch(apiError(status, code, "nope", { errors: [{ loc: ["body", "query"] }] }));
    const err = (await client(f.fetch).getMemory(MEM).catch((e: unknown) => e)) as MnemosError;
    expect(err).toBeInstanceOf(cls);
    expect(err).toBeInstanceOf(MnemosError);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(err.details).toEqual({ errors: [{ loc: ["body", "query"] }] });
    expect(err.requestId).toBe("req-123");
    expect(f.calls).toHaveLength(1);
  });

  it("handles non-JSON error bodies", async () => {
    const f = scriptedFetch(new Response("<html>Bad Gateway</html>", { status: 500, headers: { "x-request-id": "rid" } }));
    const err = (await client(f.fetch).me().catch((e: unknown) => e)) as MnemosError;
    expect(err.constructor).toBe(MnemosError);
    expect(err.code).toBe("error");
    expect(err.message).toContain("<html>Bad Gateway</html>");
    expect(err.requestId).toBe("rid");
  });

  it("rejects an invalid JSON success body", async () => {
    const f = scriptedFetch(new Response("not json", { status: 200 }));
    await expect(client(f.fetch).me()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("requires a baseUrl and a fetch implementation", () => {
    expect(() => new MnemosClient({ baseUrl: "" })).toThrow(TypeError);
    vi.stubGlobal("fetch", undefined);
    try {
      expect(() => new MnemosClient({ baseUrl: "http://x" })).toThrow(/no global fetch/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("waitForLearning", () => {
  const learningOf = (processing: string, jobStatus: string, memories: Record<string, unknown>[] = []) => ({
    job_id: "job-1",
    job_status: jobStatus,
    processing_status: processing,
    memories,
  });

  it("polls until the experience is processed and learned memories left pending validation", async () => {
    const summary = [{ id: MEM, title: "Retry flaky uploads", status: "candidate", type: "lesson" }];
    const f = scriptedFetch(
      json(200, experienceJson(learningOf("pending", "queued"))),
      json(200, experienceJson(learningOf("processed", "succeeded", summary))),
      json(200, memoryJson({ status: "candidate", review_state: "none" })), // still awaiting validation
      json(200, experienceJson(learningOf("processed", "succeeded", summary))),
      json(200, memoryJson({ status: "active", review_state: "none" })),
    );
    const exp = await client(f.fetch).waitForLearning(EXP, { timeoutMs: 5_000, pollIntervalMs: 1 });
    expect(f.calls.map((c) => new URL(c.url).pathname)).toEqual([
      `/v1/experiences/${EXP}`,
      `/v1/experiences/${EXP}`,
      `/v1/memories/${MEM}`,
      `/v1/experiences/${EXP}`,
      `/v1/memories/${MEM}`,
    ]);
    expect(exp.id).toBe(EXP);
    expect(exp.learning.processingStatus).toBe("processed");
    expect(exp.learning.memories[0]?.status).toBe("active");
    expect(exp.learning.memories[0]?.trustScore).toBe(0.7);
  });

  it("treats a candidate queued for human review as settled", async () => {
    const summary = [{ id: MEM, title: "t", status: "candidate", type: "rule" }];
    const f = scriptedFetch(
      json(200, experienceJson(learningOf("processed", "succeeded", summary))),
      json(200, memoryJson({ status: "candidate", review_state: "pending" })),
    );
    const exp = await client(f.fetch).waitForLearning(EXP, { pollIntervalMs: 1 });
    expect(exp.learning.memories[0]?.reviewState).toBe("pending");
  });

  it("fails fast when the extraction job is dead", async () => {
    const f = scriptedFetch(json(200, experienceJson(learningOf("failed", "dead"))));
    await expect(client(f.fetch).waitForLearning(EXP, { pollIntervalMs: 1 })).rejects.toMatchObject({
      code: "learning_failed",
    });
  });

  it("times out with MnemosTimeoutError", async () => {
    const pending = () => Promise.resolve(json(200, experienceJson(learningOf("pending", "queued"))));
    const f = scriptedFetch(...Array.from({ length: 1_000 }, () => pending));
    const err = await client(f.fetch)
      .waitForLearning(EXP, { timeoutMs: 30, pollIntervalMs: 5 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MnemosTimeoutError);
    expect(f.calls.length).toBeGreaterThan(1);
  });
});
