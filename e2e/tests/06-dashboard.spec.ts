import { expect, test } from '@playwright/test';
import { API, bootstrapTenant } from './helpers';

test('dashboard: login, provenance/history, feedback, conflict resolution, dreams, graph', async ({ page, request }) => {
  const t = await bootstrapTenant(request);
  const pid = await t.project('ui');
  const { memories } = await t.learn({
    project_id: pid, agent_name: 'ui-agent', task: 'Deploy reporting-api to staging',
    observation: 'Deployment failed: migration timed out on a locked table.',
    action: 'Re-ran migrations with --lock-timeout=5s after pausing the batch job.',
    result: 'Deployment succeeded.',
  });
  const mem = memories[0];
  const first = await t.learn({ project_id: pid, agent_name: 'a', task: 'Install web dependencies',
    metadata: { lessons: ['Use pnpm instead of npm to install the reporting web dependencies because the lockfile is pnpm-lock.yaml.'] } });
  const second = await t.learn({ project_id: pid, agent_name: 'b', task: 'Install web dependencies',
    metadata: { lessons: ['Use npm instead of pnpm to install the reporting web dependencies because the lockfile is package-lock.json now.'] } });
  const conflicts = await t.ok('GET', `/v1/conflicts?workspace_id=${t.workspaceId}&status=open`);
  const conflict = conflicts.items.find((c: any) => c.candidate_memory_id === second.memories[0].id);
  expect(conflict).toBeTruthy();

  // ---- login through the UI
  await page.goto('/login');
  await page.getByTestId('login-api-key').fill(t.key);
  await page.getByTestId('login-submit').click();
  const wsSelect = page.getByTestId('workspace-select');
  await expect(wsSelect.or(page.getByTestId('current-role'))).toBeVisible();
  if (await wsSelect.isVisible()) {
    await wsSelect.selectOption(t.workspaceId);
    await page.getByTestId('workspace-continue').click();
  }
  await expect(page.getByTestId('current-role')).toContainText(/admin/i);
  await expect(page.getByTestId('stat-active-memories-value')).toBeVisible();

  // ---- memories list -> detail with evidence + history
  await page.getByTestId('nav-memories').click();
  const row = page.locator(`[data-testid="memory-row"][data-id="${mem.id}"]`);
  await expect(row).toBeVisible();
  await row.getByTestId('memory-row-link').click();
  await expect(page.getByTestId('memory-detail')).toHaveAttribute('data-id', mem.id);
  await expect(page.getByTestId('memory-status-badge')).toHaveAttribute('data-status', 'active');
  await expect(page.getByTestId('memory-evidence').getByTestId('evidence-row').first()).toBeVisible();
  await expect(page.getByTestId('memory-history').getByTestId('history-row')).toHaveCount(3);

  // ---- feedback via UI -> utility increases in the API
  const before = await t.ok('GET', `/v1/memories/${mem.id}`);
  await page.getByTestId('feedback-value-helpful').click();
  await page.getByTestId('feedback-submit').click();
  await expect(page.getByTestId('memory-feedback').getByTestId('feedback-row').first()).toBeVisible();
  await expect.poll(async () => (await t.ok('GET', `/v1/memories/${mem.id}`)).utility_score).toBeGreaterThan(before.utility_score);

  // ---- conflict resolution via UI
  await page.goto(`/conflicts/${conflict.id}`);
  await expect(page.getByTestId('conflict-candidate-content')).toContainText('npm instead of pnpm');
  await page.getByTestId('conflict-resolve-accept_candidate').click();
  await expect(page.getByTestId('conflict-resolution')).toBeVisible();
  await expect.poll(async () => (await t.ok('GET', `/v1/memories/${first.memories[0].id}`)).status).toBe('superseded');

  // ---- trigger a dream via UI and watch it finish
  await page.getByTestId('nav-dreams').click();
  await page.getByTestId('dream-mode').selectOption('deduplication');
  await page.getByTestId('dream-submit').click();
  await expect(page.getByTestId('dream-status')).toHaveAttribute('data-status', 'succeeded', { timeout: 60_000 });

  // ---- knowledge graph renders nodes and the supersedes edge
  await page.getByTestId('nav-graph').click();
  await expect(page.getByTestId('graph-node').first()).toBeVisible();
  await expect(page.locator('[data-testid="graph-edge"][data-relation="supersedes"]').first()).toBeAttached();

  // ---- settings shows readiness through the reverse proxy
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-readiness-status')).toContainText(/ok/i);
  expect((await request.get(`${API}/health/ready`)).status()).toBe(200);
});
