import { expect, test } from '@playwright/test';
import { bootstrapTenant } from './helpers';

test('scenario 5: conflicting experience opens a conflict instead of silently overwriting', async ({ request }) => {
  const t = await bootstrapTenant(request);
  const pid = await t.project('web');
  const first = await t.learn({ project_id: pid, agent_name: 'a', task: 'Install web dependencies',
    metadata: { lessons: ['Use pnpm instead of npm to install the web dashboard dependencies because the lockfile is pnpm-lock.yaml.'] } });
  const existing = first.memories[0];
  expect(existing.status).toBe('active');
  const second = await t.learn({ project_id: pid, agent_name: 'b', task: 'Install web dependencies',
    metadata: { lessons: ['Use npm instead of pnpm to install the web dashboard dependencies because the lockfile is package-lock.json now.'] } });
  const cand = second.memories[0];
  expect(cand.status).toBe('disputed');
  expect((await t.ok('GET', `/v1/memories/${existing.id}`)).status).toBe('active');
  const conflicts = await t.ok('GET', `/v1/conflicts?workspace_id=${t.workspaceId}&status=open`);
  const c = conflicts.items.find((x: any) => x.candidate_memory_id === cand.id);
  expect(c.existing_memory_id).toBe(existing.id);
  const resolved = await t.ok('POST', `/v1/conflicts/${c.id}/resolve`, { data: { resolution: 'accept_candidate', note: 'lockfile migrated' } });
  expect(resolved.existing.status).toBe('superseded');
  expect(resolved.candidate.status).toBe('active');
  const ids = await t.contextIds('install web dashboard dependencies', { project_id: pid });
  expect(ids).toContain(cand.id);
  expect(ids).not.toContain(existing.id);
});

test('scenario 6: concurrent PATCH with the same version -> exactly one 200 and one 409', async ({ request }) => {
  const t = await bootstrapTenant(request);
  const m = await t.activeMemory('Nightly batch runs at 02:00 UTC.');
  const patch = (content: string) => t.call('PATCH', `/v1/memories/${m.id}`, { data: { content }, headers: { 'If-Match': `"${m.version}"` } });
  const [r1, r2] = await Promise.all([patch('Nightly batch runs at 03:00 UTC.'), patch('Nightly batch runs at 04:00 UTC.')]);
  const codes = [r1.status(), r2.status()].sort();
  expect(codes).toEqual([200, 409]);
  const loser = r1.status() === 409 ? r1 : r2;
  expect((await loser.json()).error.details.current_version).toBe(m.version + 1);
  expect((await t.call('PATCH', `/v1/memories/${m.id}`, { data: { content: 'x' } })).status()).toBe(428);
});
