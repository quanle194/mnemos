import { expect, test } from '@playwright/test';
import { bootstrapTenant, uid } from './helpers';

test('scenarios 2-4: agent A learns, agent B retrieves with evidence, helpful feedback raises utility', async ({ request }) => {
  const t = await bootstrapTenant(request);
  const pid = await t.project('billing');
  const agentA = await t.agent('agent-a');
  const agentB = await t.agent('agent-b');
  // Scenario 2: experience -> extraction -> candidate -> validation -> active
  const { experienceId, memories } = await t.learn({
    project_id: pid, agent_id: agentA, session_id: uid(), task_id: 'deploy-1',
    task: 'Deploy billing-api to staging',
    observation: 'Deployment failed: migration timed out waiting for a lock on the orders table held by the nightly batch.',
    action: 'Paused the nightly batch and re-ran migrations with --lock-timeout=5s.',
    result: 'Migrations applied and deployment succeeded.',
  });
  const mem = memories[0];
  expect(mem.status).toBe('active');
  const history = await t.ok('GET', `/v1/memories/${mem.id}/history`);
  expect(history.map((h: any) => h.snapshot_json.status)).toEqual(['candidate', 'validated', 'active']);
  const evidence = await t.ok('GET', `/v1/memories/${mem.id}/evidence`);
  expect(evidence.some((e: any) => e.source_type === 'experience' && e.source_id === experienceId)).toBeTruthy();

  // Scenario 3: agent B (different agent + session) receives the memory with evidence before acting
  const ctx = await t.ok('POST', '/v1/context', {
    data: { workspace_id: t.workspaceId, project_id: pid, agent_id: agentB, session_id: uid(), query: 'Deploy invoices-api to staging', token_budget: 1000 },
  });
  const item = ctx.memories.find((m: any) => m.id === mem.id);
  expect(item, JSON.stringify(ctx)).toBeTruthy();
  expect(item.evidence.experience).toBe(1);
  expect(ctx.context).toContain('--lock-timeout');
  expect(ctx.token_estimate).toBeLessThanOrEqual(1000);
  const usage = await t.ok('GET', `/v1/memories/${mem.id}/usage`);
  expect(usage[0].trace_id).toBe(ctx.retrieval_trace_id);

  // Scenario 4: helpful feedback increments utility (without rewriting the memory)
  const before = await t.ok('GET', `/v1/memories/${mem.id}`);
  const fb = await t.ok('POST', `/v1/memories/${mem.id}/feedback`, { data: { value: 'helpful', agent_id: agentB, retrieval_trace_id: ctx.retrieval_trace_id } });
  expect(fb.memory.utility_score).toBeGreaterThan(before.utility_score);
  const after = await t.ok('GET', `/v1/memories/${mem.id}`);
  expect(after.content).toBe(before.content);
  expect(after.version).toBe(before.version);
});
