import { vi } from "vitest";

import type { FetchInitLike, FetchResponseLike } from "../src/index.js";

export interface Call {
  url: string;
  init: FetchInitLike;
}

export type Step = Response | Error | ((init: FetchInitLike) => Promise<FetchResponseLike>);

/** A scripted fetch double: each call consumes the next step (a Response, a thrown Error, or a custom handler). */
export function scriptedFetch(...steps: Step[]) {
  const calls: Call[] = [];
  const queue = [...steps];
  const fetch = vi.fn((url: string, init: FetchInitLike): Promise<FetchResponseLike> => {
    calls.push({ url, init });
    const step = queue.shift();
    if (step === undefined) return Promise.reject(new Error(`unexpected fetch call #${String(calls.length)}: ${url}`));
    if (step instanceof Error) return Promise.reject(step);
    if (typeof step === "function") return step(init);
    return Promise.resolve(step);
  });
  return {
    fetch,
    calls,
    body(i: number): Record<string, unknown> {
      const call = calls[i];
      if (call?.init.body === undefined) throw new Error(`call ${String(i)} has no body`);
      return JSON.parse(call.init.body) as Record<string, unknown>;
    },
    header(i: number, name: string): string | undefined {
      const headers = calls[i]?.init.headers ?? {};
      const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
      return key === undefined ? undefined : headers[key];
    },
  };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return json(status, { error: { code, message, details, request_id: "req-123" } }, headers);
}

export const WS = "11111111-1111-4111-8111-111111111111";
export const AGENT = "22222222-2222-4222-8222-222222222222";
export const MEM = "33333333-3333-4333-8333-333333333333";
export const EXP = "44444444-4444-4444-8444-444444444444";

export function memoryJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MEM,
    organization_id: "00000000-0000-4000-8000-000000000000",
    workspace_id: WS,
    project_id: null,
    agent_id: AGENT,
    layer: 3,
    type: "lesson",
    scope_type: "project",
    scope_id: WS,
    title: "Retry flaky uploads",
    content: "Uploads to S3 need 3 retries with jitter.",
    status: "active",
    review_state: "none",
    confidence: 0.8,
    trust_score: 0.7,
    importance: 0.5,
    utility_score: 0.6,
    valid_from: "2026-01-01T00:00:00Z",
    valid_until: null,
    version: 3,
    metadata_json: { source_system: "ci", nested_key: { inner_key: 1 } },
    retrieval_count: 2,
    last_retrieved_at: null,
    created_by_type: "agent",
    created_by_id: "key:abc",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

export function experienceJson(learning: Record<string, unknown> | null): Record<string, unknown> {
  return {
    id: EXP,
    workspace_id: WS,
    project_id: null,
    agent_id: AGENT,
    session_id: null,
    task_id: null,
    episode_id: null,
    task: "deploy",
    observation: "",
    action: "",
    result: "",
    outcome: "success",
    importance: 0.5,
    confidence: 0.7,
    source: "agent",
    source_trust: 0.6,
    metadata_json: {},
    processing_status: learning === null ? "pending" : learning.processing_status,
    processed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    learning,
  };
}
