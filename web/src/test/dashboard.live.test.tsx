/**
 * Live smoke test: drives the real dashboard (jsdom) against a running Mnemos API — no mocks.
 * Opt-in; excluded from `npm test`. It bootstraps a fresh organization so runs are isolated:
 *
 *   MNEMOS_LIVE_API_URL=http://127.0.0.1:8000 MNEMOS_LIVE_BOOTSTRAP_SECRET=... npm run test:live
 *
 * Requires the API and a worker (with fake or real providers) to be running.
 */
import { configure, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import type { ConflictStatus, Memory, Page, Stats } from '@/api/types'
import { renderApp } from './render'

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const BASE = (env.MNEMOS_LIVE_API_URL ?? '').replace(/\/+$/, '')
const SECRET = env.MNEMOS_LIVE_BOOTSTRAP_SECRET ?? 'change-me'

configure({ asyncUtilTimeout: 20_000 })

let KEY = ''
let WS = ''
const ctx: { rule?: Memory; pending?: Memory } = {}

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  key = KEY,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T }
}

async function until<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 45_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 500))
  }
}

const session = () => ({ apiUrl: BASE, apiKey: KEY, workspaceId: WS })
const suffix = Date.now().toString(36)

describe.runIf(Boolean(BASE))('dashboard against a live API', () => {
  beforeAll(async () => {
    const res = await fetch(`${BASE}/v1/admin/bootstrap`, {
      method: 'POST',
      headers: { 'X-Bootstrap-Secret': SECRET, 'content-type': 'application/json' },
      body: JSON.stringify({ organization_name: `web-live-${suffix}`, workspace_name: 'default' }),
    })
    expect(res.status).toBe(201)
    const boot = (await res.json()) as { api_key: string; workspace_id: string }
    KEY = boot.api_key
    WS = boot.workspace_id

    for (const e of [
      {
        task: 'Run the integration test suite',
        observation: 'relation "memories" does not exist',
        action: 'ran make migrate before the tests',
        result: 'all integration tests passed after migrating',
        outcome: 'success',
        agent_name: 'ci-bot',
        project_name: 'api',
      },
      {
        task: 'Deploy the dashboard',
        observation: 'nginx served stale assets',
        action: 'purged the cache and redeployed',
        result: 'dashboard updated',
        outcome: 'success',
        agent_name: 'deployer',
      },
    ]) {
      expect(
        (await api('POST', '/v1/experiences', { workspace_id: WS, importance: 0.8, confidence: 0.9, ...e }))
          .status,
      ).toBe(201)
    }
    const rule = await api<Memory>('POST', '/v1/memories', {
      workspace_id: WS,
      type: 'rule',
      scope_type: 'workspace',
      title: 'Always run database migrations before integration tests',
      content: 'Always run `make migrate` before running the integration test suite.',
      confidence: 0.85,
      importance: 0.8,
      status: 'active',
    })
    expect(rule.status).toBe(201)
    ctx.rule = rule.data
    await api('POST', '/v1/memories', {
      workspace_id: WS,
      type: 'rule',
      scope_type: 'workspace',
      title: 'Never run database migrations before integration tests',
      content: 'Never run `make migrate` before running the integration test suite.',
      confidence: 0.6,
    })
    await api('POST', '/v1/memories', {
      workspace_id: WS,
      type: 'fact',
      scope_type: 'workspace',
      title: 'Staging runs Postgres 16 with pgvector 0.8',
      content: 'The staging cluster runs PostgreSQL 16 with the pgvector 0.8 extension.',
      confidence: 0.4,
    })
    ctx.pending = await until(async () => {
      const r = await api<Page<Memory>>(
        'GET',
        `/v1/memories?workspace_id=${WS}&review_state=pending&status=candidate`,
      )
      return r.data.items[0]
    })
    await until(async () => {
      const r = await api<Page<{ status: ConflictStatus }>>(
        'GET',
        `/v1/conflicts?workspace_id=${WS}&status=open`,
      )
      return r.data.items.length > 0
    })
    await api('POST', '/v1/memories/search', { workspace_id: WS, query: 'how do I run integration tests' })
    await api('POST', '/v1/evals/runs', {
      workspace_id: WS,
      name: 'live smoke eval',
      summary: { measured: { task_success_rate: 1 }, estimated: { tokens_saved: 500 } },
      result: { cases: [] },
    })
  })

  it('logs in with a key + API URL, picks the workspace and shows real stats', async () => {
    const { user } = renderApp('/', { session: null })
    await user.type(await screen.findByTestId('login-api-key'), KEY)
    await user.type(screen.getByTestId('login-api-url'), BASE)
    await user.click(screen.getByTestId('login-submit'))
    await user.selectOptions(await screen.findByTestId('workspace-select'), WS)
    await user.click(screen.getByTestId('workspace-continue'))
    const stats = (await api<Stats>('GET', `/v1/stats?workspace_id=${WS}`)).data
    await waitFor(() =>
      expect(screen.getByTestId('stat-active-memories-value')).toHaveTextContent(
        String(stats.memories_by_status.active ?? 0),
      ),
    )
    expect(screen.getByTestId('stat-pending-review-value')).toHaveTextContent(String(stats.pending_review))
    expect((await screen.findAllByTestId('audit-row')).length).toBeGreaterThan(0)
  })

  it('lists and filters memories', async () => {
    const { user } = renderApp('/memories', { session: session() })
    expect((await screen.findAllByTestId('memory-row')).length).toBeGreaterThan(2)
    await user.selectOptions(screen.getByTestId('memory-filter-status'), 'disputed')
    await waitFor(() => {
      const rows = screen.getAllByTestId('memory-row')
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) expect(r).toHaveAttribute('data-status', 'disputed')
    })
  })

  it('shows memory detail sections and records feedback', async () => {
    const id = ctx.rule!.id
    const { user } = renderApp(`/memories/${id}`, { session: session() })
    expect(await screen.findByTestId('memory-status-badge')).toBeInTheDocument()
    expect((await screen.findAllByTestId('evidence-row')).length).toBeGreaterThan(0)
    expect((await screen.findAllByTestId('history-row')).length).toBeGreaterThan(0)
    await user.click(screen.getByTestId('feedback-value-helpful'))
    await user.click(screen.getByTestId('feedback-submit'))
    expect(await screen.findByTestId('feedback-row')).toHaveTextContent('Helpful')
    const fb = await api<{ value: string }[]>('GET', `/v1/memories/${id}/feedback`)
    expect(fb.data.map((f) => f.value)).toContain('helpful')
  })

  it('detects a concurrent edit (409), reloads and saves on the new version', async () => {
    const id = ctx.rule!.id
    const { user } = renderApp(`/memories/${id}`, { session: session() })
    await user.click(await screen.findByTestId('memory-edit-button'))
    const form = await screen.findByTestId('memory-edit-form')
    const base = Number(screen.getByTestId('memory-edit-base-version').textContent)
    // Another writer updates the memory first.
    const other = await fetch(`${BASE}/v1/memories/${id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        'If-Match': `"${base}"`,
      },
      body: JSON.stringify({ importance: 0.9, reason: 'concurrent writer' }),
    })
    expect(other.status).toBe(200)
    const title = within(form).getByTestId('memory-edit-title')
    await user.clear(title)
    await user.type(title, `Always run migrations first (${suffix})`)
    await user.click(screen.getByTestId('memory-edit-submit'))
    expect(await screen.findByTestId('memory-conflict-alert')).toHaveTextContent(`version ${base + 1}`)
    await user.click(screen.getByTestId('memory-conflict-reload'))
    await waitFor(() =>
      expect(screen.getByTestId('memory-edit-base-version')).toHaveTextContent(String(base + 1)),
    )
    await user.clear(within(form).getByTestId('memory-edit-title'))
    await user.type(within(form).getByTestId('memory-edit-title'), `Always run migrations first (${suffix})`)
    await user.click(screen.getByTestId('memory-edit-submit'))
    await waitFor(() => expect(screen.queryByTestId('memory-edit-form')).not.toBeInTheDocument())
    const after = await api<Memory>('GET', `/v1/memories/${id}`)
    expect(after.data.version).toBe(base + 2)
    expect(after.data.title).toContain(suffix)
  })

  it('approves a pending candidate', async () => {
    const { user } = renderApp(`/memories/${ctx.pending!.id}`, { session: session() })
    await user.click(await screen.findByTestId('memory-approve-button'))
    await user.click(await screen.findByTestId('memory-review-dialog-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('memory-status-badge')).toHaveAttribute('data-status', 'active'),
    )
  })

  it('runs a semantic search with score breakdowns', async () => {
    const { user } = renderApp('/memories?tab=search', { session: session() })
    await user.type(await screen.findByTestId('memory-search-input'), 'integration tests migrations')
    await user.click(screen.getByTestId('memory-search-submit'))
    const results = await screen.findAllByTestId('search-result')
    expect(results.length).toBeGreaterThan(0)
    expect(within(results[0]!).getByTestId('search-result-score').textContent).toMatch(/^\d\.\d{3}$/)
  })

  it('records an experience and follows learning until processed', async () => {
    const { user } = renderApp('/experiences', { session: session() })
    await user.click(await screen.findByTestId('experience-create-open'))
    const form = await screen.findByTestId('experience-form')
    await user.type(within(form).getByTestId('experience-task'), `Rotate the API key for ci (${suffix})`)
    await user.type(
      within(form).getByTestId('experience-result'),
      'rotated the key via the dashboard and updated CI secrets',
    )
    await user.click(within(form).getByTestId('experience-submit'))
    await screen.findByTestId('experience-detail')
    await waitFor(
      () =>
        expect(screen.getByTestId('experience-processing-status')).toHaveAttribute(
          'data-status',
          'processed',
        ),
      { timeout: 45_000 },
    )
  })

  it('triggers a dream and follows it to completion', async () => {
    const { user } = renderApp('/dreams', { session: session() })
    await user.selectOptions(await screen.findByTestId('dream-mode'), 'deduplication')
    await user.click(screen.getByTestId('dream-submit'))
    await screen.findByTestId('dream-detail')
    await waitFor(
      () => expect(screen.getByTestId('dream-status')).toHaveAttribute('data-status', 'succeeded'),
      {
        timeout: 45_000,
      },
    )
    expect(screen.getByTestId('dream-stats')).toHaveTextContent(/Memories scanned/)
  })

  it('resolves an open conflict', async () => {
    const { user } = renderApp('/conflicts', { session: session() })
    const row = (await screen.findAllByTestId('conflict-row'))[0]!
    await user.click(within(row).getByTestId('conflict-row-link'))
    expect(await screen.findByTestId('conflict-candidate')).toBeInTheDocument()
    expect(screen.getByTestId('conflict-existing')).toBeInTheDocument()
    await user.click(screen.getByTestId('conflict-resolve-keep_both'))
    await waitFor(() =>
      expect(screen.getByTestId('conflict-status')).toHaveAttribute('data-status', 'resolved'),
    )
  })

  it('renders the knowledge graph', async () => {
    renderApp('/graph', { session: session() })
    expect((await screen.findAllByTestId('graph-node')).length).toBeGreaterThan(0)
  })

  it('creates an agent', async () => {
    const { user } = renderApp('/agents', { session: session() })
    await user.type(await screen.findByTestId('agent-name'), `live-agent-${suffix}`)
    await user.click(screen.getByTestId('agent-submit'))
    await waitFor(() => expect(screen.getByTestId('agent-list')).toHaveTextContent(`live-agent-${suffix}`))
  })

  it('creates an API key (shown once) and revokes it', async () => {
    const { user } = renderApp('/workspaces', { session: session() })
    await user.type(await screen.findByTestId('api-key-name'), `live-viewer-${suffix}`)
    await user.selectOptions(screen.getByTestId('api-key-role'), 'viewer')
    await user.click(screen.getByTestId('api-key-submit'))
    const raw = (await screen.findByTestId('api-key-created-value')).getAttribute('value') ?? ''
    expect(raw).toMatch(/^mnm_/)
    expect((await api<{ role: string }>('GET', '/v1/me', undefined, raw)).data.role).toBe('viewer')
    await user.click(screen.getByTestId('api-key-created-close'))
    const row = (await screen.findAllByTestId('api-key-row')).find((r) =>
      r.textContent?.includes(`live-viewer-${suffix}`),
    )!
    await user.click(within(row).getByTestId('api-key-revoke'))
    await user.click(await screen.findByTestId('api-key-revoke-dialog-confirm'))
    await waitFor(async () => expect((await api('GET', '/v1/me', undefined, raw)).status).toBe(401))
  })

  it('lists eval runs with estimate labels', async () => {
    renderApp('/evals', { session: session() })
    expect(await screen.findByTestId('eval-row')).toHaveTextContent('(est.)')
  })

  it('shows readiness, jobs and retrieval traces', async () => {
    const { user } = renderApp('/settings', { session: session() })
    expect(await screen.findByTestId('settings-readiness-status')).toHaveTextContent('ok')
    await user.click(screen.getByTestId('settings-tab-jobs'))
    expect((await screen.findAllByTestId('job-row')).length).toBeGreaterThan(0)
    await user.click(screen.getByTestId('settings-tab-traces'))
    const trace = (await screen.findAllByTestId('trace-row'))[0]!
    await user.click(within(trace).getByRole('link'))
    expect(await screen.findByTestId('trace-detail')).toBeInTheDocument()
    expect((await screen.findAllByTestId('trace-selected-row')).length).toBeGreaterThan(0)
  })
})
