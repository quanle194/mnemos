import { expect, test } from '@playwright/test';
import { API, bootstrapTenant, compose, waitFor } from './helpers';

test('scenario 10: restart containers/workers; persisted state and queued jobs stay consistent', async ({ request }) => {
  test.setTimeout(300_000);
  const t = await bootstrapTenant(request);
  const pid = await t.project('restart');
  const before = await t.learn({ project_id: pid, task: 'Restart drill: rebuild search index', observation: 'Index build failed with OOM at 2GB heap.', action: 'Raised the indexer heap to 4GB with INDEXER_HEAP=4g.', result: 'Index rebuilt.' });
  const mem = before.memories[0];
  expect(mem.status).toBe('active');

  // stop the worker, enqueue work while it is down
  compose('stop worker');
  const queued = await t.ok('POST', '/v1/experiences', { data: { workspace_id: t.workspaceId, project_id: pid, outcome: 'success',
    task: 'Restart drill: warm the cache after deploy', observation: 'Cold cache caused p95 latency spikes after deploy.', action: 'Ran the cache warmer job right after deploy.', result: 'Latency stayed flat.' } });
  const pending = await t.ok('GET', `/v1/experiences/${queued.experience.id}`);
  expect(pending.processing_status).toBe('pending');

  // restart the whole stack (db, redis, api, worker, proxy)
  compose('restart');
  await waitFor(async () => {
    const r = await request.get(`${API}/health/ready`);
    return r.status() === 200 ? true : null;
  }, 180_000, 2000);

  // previously learned state persisted; API key still valid
  const got = await t.ok('GET', `/v1/memories/${mem.id}`);
  expect(got.status).toBe('active');
  expect(got.version).toBe(mem.version);
  expect(await t.contextIds('rebuild search index heap', { project_id: pid })).toContain(mem.id);
  // the job queued while the worker was down is processed exactly once after restart
  const done = await waitFor(async () => {
    const d = await t.ok('GET', `/v1/experiences/${queued.experience.id}`);
    return d.processing_status === 'processed' && d.learning.memories.length ? d : null;
  }, 120_000);
  expect(done.learning.job_status).toBe('succeeded');
  const all = await t.ok('GET', `/v1/memories?workspace_id=${t.workspaceId}&limit=200`);
  const fromQueued = all.items.filter((m: any) => m.metadata_json?.extraction?.experience_id === queued.experience.id);
  expect(fromQueued).toHaveLength(done.learning.memories.length);
});
