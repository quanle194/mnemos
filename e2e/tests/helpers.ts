import { APIRequestContext, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const API = process.env.E2E_API_PREFIX ?? '/api';
export const SECRET = process.env.API_BOOTSTRAP_SECRET ?? '';

export type Json = Record<string, any>;

export class Tenant {
  constructor(
    public request: APIRequestContext,
    public orgId: string,
    public workspaceId: string,
    public key: string,
  ) {}

  headers(key?: string, extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${key ?? this.key}`, ...extra };
  }

  async call(method: string, path: string, opts: { data?: unknown; key?: string; headers?: Record<string, string> } = {}) {
    return this.request.fetch(`${API}${path}`, {
      method,
      data: opts.data as any,
      headers: this.headers(opts.key, opts.headers),
    });
  }

  async ok(method: string, path: string, opts: { data?: unknown; key?: string; headers?: Record<string, string> } = {}): Promise<any> {
    const r = await this.call(method, path, opts);
    expect(r.status(), `${method} ${path}: ${await r.text()}`).toBeLessThan(300);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  async project(name: string): Promise<string> {
    return (await this.ok('POST', `/v1/workspaces/${this.workspaceId}/projects`, { data: { name } })).id;
  }

  async agent(name: string): Promise<string> {
    return (await this.ok('POST', `/v1/workspaces/${this.workspaceId}/agents`, { data: { name } })).id;
  }

  async makeKey(role: string): Promise<string> {
    return (await this.ok('POST', '/v1/api-keys', { data: { name: `${role}-${randomUUID().slice(0, 6)}`, role } })).api_key;
  }

  /** Record an experience and wait (real worker, async) until learning finished. */
  async learn(exp: Json, timeoutMs = 60_000): Promise<{ experienceId: string; memories: Json[] }> {
    const created = await this.ok('POST', '/v1/experiences', {
      data: { workspace_id: this.workspaceId, outcome: 'success', ...exp },
      headers: { 'Idempotency-Key': randomUUID() },
    });
    const id = created.experience.id;
    const memories = await waitFor(async () => {
      const d = await this.ok('GET', `/v1/experiences/${id}`);
      if (d.processing_status !== 'processed') return null;
      const mems = await Promise.all(d.learning.memories.map((m: Json) => this.ok('GET', `/v1/memories/${m.id}`)));
      return mems.every((m: Json) => m.status !== 'candidate' || m.review_state !== 'none') ? mems : null;
    }, timeoutMs);
    return { experienceId: id, memories };
  }

  async activeMemory(content: string, extra: Json = {}): Promise<Json> {
    return this.ok('POST', '/v1/memories', {
      data: {
        workspace_id: this.workspaceId, type: 'lesson', title: content.slice(0, 60), content, status: 'active',
        confidence: 0.8, scope_type: extra.project_id ? 'project' : 'workspace', ...extra,
      },
    });
  }

  async contextIds(query: string, extra: Json = {}): Promise<string[]> {
    const r = await this.ok('POST', '/v1/context', {
      data: { workspace_id: this.workspaceId, query, token_budget: 3000, ...extra },
    });
    return r.memories.map((m: Json) => m.id);
  }

  async dream(mode: string): Promise<Json> {
    const d = await this.ok('POST', '/v1/dreams', { data: { workspace_id: this.workspaceId, mode } });
    return waitFor(async () => {
      const cur = await this.ok('GET', `/v1/dreams/${d.id}`);
      return ['succeeded', 'failed'].includes(cur.status) ? cur : null;
    }, 60_000);
  }
}

export async function bootstrapTenant(request: APIRequestContext, name?: string): Promise<Tenant> {
  expect(SECRET, 'API_BOOTSTRAP_SECRET must be set for E2E').not.toBe('');
  const r = await request.post(`${API}/v1/admin/bootstrap`, {
    data: { organization_name: name ?? `e2e-${randomUUID().slice(0, 8)}`, workspace_name: 'main' },
    headers: { 'X-Bootstrap-Secret': SECRET },
  });
  expect(r.status(), await r.text()).toBe(201);
  const b = await r.json();
  return new Tenant(request, b.organization_id, b.workspace_id, b.api_key);
}

export async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number, intervalMs = 400): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms ${lastErr ? String(lastErr) : ''}`);
}

export function compose(args: string): string {
  const cmd = process.env.E2E_COMPOSE;
  if (!cmd) throw new Error('E2E_COMPOSE must be set to the docker compose command for the stack under test');
  return execSync(`${cmd} ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 });
}

export const uid = () => randomUUID();
