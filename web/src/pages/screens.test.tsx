import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Dream, Job } from '@/api/types'
import { MEM1, MEM2, memory, NOW, page, stats, withSession, WS1 } from '@/test/fixtures'
import { MockApi } from '@/test/mock-api'
import { renderApp } from '@/test/render'

const DREAM_ID = '0192f0a0-0000-7000-8000-00000000f001'

function dream(overrides: Partial<Dream> = {}): Dream {
  return {
    id: DREAM_ID,
    workspace_id: WS1,
    mode: 'deduplication',
    status: 'queued',
    trigger_type: 'manual',
    window_hash: null,
    input_window_json: { active_memories: 3 },
    result_json: {},
    checkpoint_json: {},
    error: null,
    started_at: null,
    completed_at: null,
    created_at: NOW,
    ...overrides,
  }
}

describe('Overview', () => {
  it('renders stat tiles, distributions and the audit log', async () => {
    withSession(new MockApi())
      .get('/v1/stats', { body: stats })
      .get(
        '/v1/audit-logs',
        page([
          {
            id: 'a1',
            workspace_id: WS1,
            actor_type: 'worker',
            actor_id: 'validator',
            action: 'memory.promote',
            resource_type: 'memory',
            resource_id: MEM1,
            before_json: {},
            after_json: {},
            request_id: null,
            created_at: NOW,
          },
        ]),
      )
      .install()
    renderApp('/')
    expect(await screen.findByTestId('stat-active-memories-value')).toHaveTextContent('12')
    expect(screen.getByTestId('stat-pending-review-value')).toHaveTextContent('2')
    expect(screen.getByTestId('stat-open-conflicts-value')).toHaveTextContent('1')
    expect(screen.getByTestId('stat-retrievals-24h-value')).toHaveTextContent('42')
    const byStatus = screen.getByTestId('dist-memories-status')
    expect(
      within(byStatus)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('data-key')),
    ).toEqual(['candidate', 'active', 'archived'])
    const row = await screen.findByTestId('audit-row')
    expect(row).toHaveTextContent('memory.promote')
    expect(within(row).getByRole('link')).toHaveAttribute('href', `/memories/${MEM1}`)
  })
})

describe('Dreams', () => {
  it('triggers a dream and polls the detail until it finishes', async () => {
    let polls = 0
    const api = withSession(new MockApi())
      .get('/v1/dreams', page([]))
      .post('/v1/dreams', { status: 202, body: dream() })
      .get(`/v1/dreams/${DREAM_ID}`, () => {
        polls += 1
        return polls < 2
          ? { body: dream({ status: 'running', started_at: NOW }) }
          : {
              body: dream({
                status: 'succeeded',
                completed_at: NOW,
                result_json: {
                  applied: [{ canonical: MEM1, duplicates: [MEM2] }],
                  proposals: [],
                  stats: { memories_scanned: 3, clusters: 1, superseded: 1 },
                  duration_ms: 12.3,
                },
              }),
            }
      })
      .install()
    const { user } = renderApp('/dreams')
    await user.selectOptions(await screen.findByTestId('dream-mode'), 'deduplication')
    await user.click(screen.getByTestId('dream-dedupe'))
    await user.click(screen.getByTestId('dream-submit'))
    await waitFor(() => expect(api.callsTo('POST', '/v1/dreams')).toHaveLength(1))
    expect(api.lastCall('POST', '/v1/dreams')!.body).toEqual({
      workspace_id: WS1,
      mode: 'deduplication',
      dedupe_window: true,
    })

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/dreams/${DREAM_ID}`))
    await waitFor(
      () => expect(screen.getByTestId('dream-status')).toHaveAttribute('data-status', 'succeeded'),
      {
        timeout: 5000,
      },
    )
    expect(screen.getByTestId('dream-stat-superseded')).toHaveTextContent('1')
    const applied = screen.getByTestId('dream-applied-item')
    expect(
      within(applied)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual([`/memories/${MEM1}`, `/memories/${MEM2}`])
    expect(screen.queryByTestId('dream-polling')).not.toBeInTheDocument()
  }, 12_000)

  it('hides the trigger form without dream:run', async () => {
    withSession(new MockApi(), 'agent')
      .get('/v1/dreams', page([dream({ status: 'succeeded' })]))
      .install()
    renderApp('/dreams')
    expect(await screen.findByTestId('dream-row')).toBeInTheDocument()
    expect(screen.queryByTestId('dream-form')).not.toBeInTheDocument()
  })
})

describe('Knowledge graph', () => {
  it('renders nodes and labelled edges and navigates on node click', async () => {
    withSession(new MockApi())
      .get('/v1/graph', {
        body: {
          nodes: [
            {
              id: MEM1,
              title: 'Run migrations before tests',
              type: 'rule',
              status: 'active',
              layer: 3,
              confidence: 0.8,
              utility: 0.6,
            },
            {
              id: MEM2,
              title: 'Tests need a database',
              type: 'lesson',
              status: 'superseded',
              layer: 3,
              confidence: 0.6,
              utility: 0.3,
            },
          ],
          edges: [{ id: 'e1', source: MEM1, target: MEM2, relation: 'supersedes' }],
        },
      })
      .get(`/v1/memories/${MEM1}`, { body: memory() })
      .install()
    const { user } = renderApp('/graph')
    const nodes = await screen.findAllByTestId('graph-node')
    expect(nodes).toHaveLength(2)
    const edge = screen.getByTestId('graph-edge')
    expect(edge).toHaveAttribute('data-relation', 'supersedes')
    expect(edge).toHaveTextContent('supersedes')
    expect(screen.getByTestId('graph-node-count')).toHaveTextContent('2 nodes')
    await user.click(nodes.find((n) => n.getAttribute('data-id') === MEM1)!)
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/memories/${MEM1}`))
  })
})

describe('Workspaces & API keys', () => {
  it('creates a key and shows the raw secret exactly once', async () => {
    const api = withSession(new MockApi())
      .get('/v1/api-keys', { body: [] })
      .post('/v1/api-keys', {
        status: 201,
        body: {
          id: 'k1',
          name: 'ci agent',
          prefix: 'mnm_ab12cd34',
          role: 'agent',
          workspace_ids: [WS1],
          created_at: NOW,
          revoked_at: null,
          last_used_at: null,
          api_key: 'mnm_ab12cd34_THE-SECRET',
        },
      })
      .install()
    const { user } = renderApp('/workspaces')
    expect(await screen.findAllByTestId('workspace-row')).toHaveLength(2)
    await user.type(await screen.findByTestId('api-key-name'), 'ci agent')
    await user.selectOptions(screen.getByTestId('api-key-role'), 'agent')
    await user.click(screen.getAllByTestId('api-key-workspace')[0]!)
    await user.click(screen.getByTestId('api-key-submit'))
    expect(await screen.findByTestId('api-key-created-value')).toHaveValue('mnm_ab12cd34_THE-SECRET')
    expect(api.lastCall('POST', '/v1/api-keys')!.body).toEqual({
      name: 'ci agent',
      role: 'agent',
      workspace_ids: [WS1],
    })
    await user.click(screen.getByTestId('api-key-created-close'))
    await waitFor(() => expect(screen.queryByTestId('api-key-created-dialog')).not.toBeInTheDocument())
    expect(screen.queryByText('mnm_ab12cd34_THE-SECRET')).not.toBeInTheDocument()
  })

  it('hides key management from non-admins', async () => {
    withSession(new MockApi(), 'maintainer').install()
    renderApp('/workspaces')
    expect(await screen.findAllByTestId('workspace-row')).toHaveLength(2)
    expect(screen.queryByTestId('api-key-form')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workspace-form')).not.toBeInTheDocument()
  })
})

describe('Settings', () => {
  it('shows identity and readiness (including 503 bodies) and retries dead jobs', async () => {
    const dead: Job = {
      id: 'job-dead',
      kind: 'extract_experience',
      status: 'dead',
      attempts: 5,
      max_attempts: 5,
      payload_json: {},
      last_error: 'ProviderError: timeout',
      result_json: {},
      run_after: NOW,
      created_at: NOW,
      completed_at: null,
    }
    const api = withSession(new MockApi(), 'maintainer')
      .get('/health/ready', {
        status: 503,
        body: {
          status: 'unavailable',
          checks: {
            database: { ok: true, pgvector: '0.8.0', migration: '0001' },
            redis: { ok: false },
            providers: { llm: 'fake', embedding: 'fake-hash', embedding_dimensions: 384 },
            queue: { queued: 2 },
          },
        },
      })
      .get('/v1/jobs', page([dead]))
      .post('/v1/jobs/job-dead/retry', { body: { requeued: true } })
      .install()
    const { user } = renderApp('/settings')
    expect(await screen.findByTestId('settings-api-url')).toHaveTextContent('/api')
    expect(screen.getByTestId('settings-role')).toHaveTextContent('maintainer')
    expect(await screen.findByTestId('settings-readiness-status')).toHaveTextContent('unavailable')
    expect(screen.getByTestId('settings-provider-llm')).toHaveTextContent('fake')
    expect(screen.getByTestId('settings-provider-embedding')).toHaveTextContent('fake-hash')
    expect(api.lastCall('GET', '/health/ready')!.url.pathname).toBe('/api/health/ready')

    await user.click(screen.getByTestId('settings-tab-jobs'))
    const row = await screen.findByTestId('job-row')
    expect(row).toHaveTextContent('ProviderError: timeout')
    await user.click(within(row).getByTestId('job-retry'))
    await waitFor(() => expect(api.callsTo('POST', '/v1/jobs/job-dead/retry')).toHaveLength(1))
  })
})

describe('Evals', () => {
  it('labels measured vs estimated metrics and expands the full result', async () => {
    withSession(new MockApi())
      .get(
        '/v1/evals/runs',
        page([
          {
            id: 'run-1',
            workspace_id: null,
            name: 'repeated-failure benchmark',
            status: 'completed',
            summary_json: { measured: { task_success_rate: 0.9 }, estimated: { tokens_saved: 1200 } },
            result_json: { cases: [{ id: 'c1', passed: true }] },
            created_at: NOW,
          },
        ]),
      )
      .install()
    const { user } = renderApp('/evals')
    const row = await screen.findByTestId('eval-row')
    expect(row).toHaveTextContent('Tokens saved: 1200 (est.)')
    await user.click(within(row).getByTestId('eval-row-toggle'))
    const metrics = await screen.findAllByTestId('eval-metric')
    const cells = metrics.map((m) =>
      within(m)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    )
    expect(cells).toEqual([
      ['task_success_rate', '0.900', 'measured'],
      ['tokens_saved', '1200', 'estimated'],
    ])
    expect(metrics.map((m) => m.getAttribute('data-kind'))).toEqual(['measured', 'estimated'])
    expect(screen.getByTestId('eval-result-json')).toHaveTextContent('"passed": true')
  })
})
