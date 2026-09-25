import { expect, test } from '@playwright/test';
import { bootstrapTenant, uid } from './helpers';

test('scenario 1: two tenants are completely isolated', async ({ request }) => {
  const a = await bootstrapTenant(request);
  const b = await bootstrapTenant(request);
  const pid = await a.project('falcon');
  const { experienceId, memories } = await a.learn({
    project_id: pid, agent_name: 'a1', session_id: uid(), task_id: 'iso-1',
    task: 'Rotate the falcon-cluster database credentials',
    observation: 'Rotation failed because the connection pooler cached the old password.',
    action: 'Reloaded pgbouncer after rotating credentials with vault.',
    result: 'Credentials rotated and falcon-cluster reconnected.',
  });
  const mem = memories[0];
  expect(mem.status).toBe('active');
  const ctx = await a.ok('POST', '/v1/context', { data: { workspace_id: a.workspaceId, project_id: pid, query: 'rotate falcon credentials', token_budget: 1500 } });
  expect(ctx.memories.map((m: any) => m.id)).toContain(mem.id);
  const dream = await a.dream('deduplication');
  const episodeId = (await a.ok('GET', `/v1/experiences/${experienceId}`)).episode_id;

  for (const path of [
    `/v1/memories/${mem.id}`, `/v1/memories/${mem.id}/evidence`, `/v1/memories/${mem.id}/history`,
    `/v1/memories/${mem.id}/relations`, `/v1/memories/${mem.id}/usage`, `/v1/experiences/${experienceId}`,
    `/v1/episodes/${episodeId}`, `/v1/retrieval-traces/${ctx.retrieval_trace_id}`, `/v1/dreams/${dream.id}`,
    `/v1/workspaces/${a.workspaceId}`, `/v1/stats?workspace_id=${a.workspaceId}`, `/v1/graph?workspace_id=${a.workspaceId}`,
  ]) {
    const r = await b.call('GET', path);
    expect(r.status(), path).toBe(404);
  }
  expect((await b.call('POST', '/v1/context', { data: { workspace_id: a.workspaceId, query: 'falcon', token_budget: 500 } })).status()).toBe(404);
  expect((await b.call('POST', '/v1/memories/search', { data: { workspace_id: a.workspaceId, query: 'falcon' } })).status()).toBe(404);
  expect((await b.call('POST', `/v1/memories/${mem.id}/feedback`, { data: { value: 'harmful' } })).status()).toBe(404);
  const own = await b.ok('POST', '/v1/memories/search', { data: { workspace_id: b.workspaceId, query: 'rotate falcon-cluster database credentials pgbouncer' } });
  expect(own.items).toEqual([]);
  const ownCtx = await b.ok('POST', '/v1/context', { data: { workspace_id: b.workspaceId, query: 'falcon-cluster credentials', token_budget: 1500, min_relevance: 0 } });
  expect(ownCtx.memories).toEqual([]);
  // A's data is unaffected
  expect((await a.ok('GET', `/v1/memories/${mem.id}`)).status).toBe('active');
});
