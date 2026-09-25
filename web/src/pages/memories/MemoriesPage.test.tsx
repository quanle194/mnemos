import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Memory } from '@/api/types'
import { MEM1, MEM2, memory, page, withSession, WS1 } from '@/test/fixtures'
import { MockApi, type MockRequest } from '@/test/mock-api'
import { renderApp } from '@/test/render'

const ALL: Memory[] = [
  memory(),
  memory({
    id: MEM2,
    title: 'Prefer pnpm in the web app',
    type: 'preference',
    status: 'candidate',
    review_state: 'pending',
    version: 1,
  }),
]

/** Server-side filtering emulation so the test exercises the real query parameters. */
function listHandler(req: MockRequest) {
  const status = req.query.get('status')
  const type = req.query.get('type')
  const q = req.query.get('q')?.toLowerCase()
  const items = ALL.filter(
    (m) =>
      (!status || m.status === status) &&
      (!type || m.type === type) &&
      (!q || m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q)),
  )
  return page(items)
}

describe('Memories list', () => {
  it('renders rows with status badges and links to the detail page', async () => {
    const api = withSession(new MockApi()).get('/v1/memories', listHandler).install()
    renderApp('/memories')
    const rows = await screen.findAllByTestId('memory-row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByTestId('memory-row-status')).toHaveTextContent('Active')
    expect(within(rows[1]!).getByTestId('memory-row-status')).toHaveAttribute('data-status', 'candidate')
    expect(within(rows[1]!).getByText('Pending')).toBeInTheDocument()
    expect(within(rows[0]!).getByTestId('memory-row-link')).toHaveAttribute('href', `/memories/${MEM1}`)
    const call = api.lastCall('GET', '/v1/memories')!
    expect(call.query.get('workspace_id')).toBe(WS1)
    expect(call.query.get('limit')).toBe('25')
  })

  it('filters by status and type via query parameters (kept in the URL)', async () => {
    const api = withSession(new MockApi()).get('/v1/memories', listHandler).install()
    const { user } = renderApp('/memories')
    await screen.findAllByTestId('memory-row')

    await user.selectOptions(screen.getByTestId('memory-filter-status'), 'candidate')
    await waitFor(() => expect(screen.getAllByTestId('memory-row')).toHaveLength(1))
    expect(screen.getByTestId('memory-row')).toHaveAttribute('data-id', MEM2)
    expect(api.lastCall('GET', '/v1/memories')!.query.get('status')).toBe('candidate')
    expect(screen.getByTestId('location')).toHaveTextContent('status=candidate')

    await user.selectOptions(screen.getByTestId('memory-filter-type'), 'rule')
    expect(await screen.findByTestId('empty-state')).toHaveTextContent('No memories match')
    const last = api.lastCall('GET', '/v1/memories')!
    expect(last.query.get('status')).toBe('candidate')
    expect(last.query.get('type')).toBe('rule')

    await user.click(screen.getByTestId('memory-filter-clear'))
    await waitFor(() => expect(screen.getAllByTestId('memory-row')).toHaveLength(2))
  })

  it('debounces the text filter and sends it as q', async () => {
    const api = withSession(new MockApi()).get('/v1/memories', listHandler).install()
    const { user } = renderApp('/memories?layer=3')
    await screen.findAllByTestId('memory-row')
    expect(api.lastCall('GET', '/v1/memories')!.query.get('layer')).toBe('3')

    await user.type(screen.getByTestId('memory-filter-q'), 'pnpm')
    await waitFor(() => expect(screen.getAllByTestId('memory-row')).toHaveLength(1), { timeout: 2000 })
    expect(api.lastCall('GET', '/v1/memories')!.query.get('q')).toBe('pnpm')
    // Debounced: no request per keystroke.
    const qValues = api.callsTo('GET', '/v1/memories').map((c) => c.query.get('q'))
    expect(qValues.filter((v) => v && v !== 'pnpm')).toEqual([])
  })

  it('runs a semantic search and shows score, breakdown and reasons', async () => {
    const api = withSession(new MockApi())
      .get('/v1/memories', listHandler)
      .post('/v1/memories/search', {
        body: {
          items: [
            {
              memory: memory(),
              score: 0.8123,
              scores: { semantic: 0.9, lexical: 0.4, trust: 0.7, total: 0.8123 },
              reasons: ['semantic match', 'workspace scope'],
            },
          ],
          retrieval_trace_id: '0192f0a0-0000-7000-8000-00000000e001',
          weights: { relevance: 0.5 },
        },
      })
      .install()
    const { user } = renderApp('/memories?tab=search')
    await user.type(await screen.findByTestId('memory-search-input'), 'how to run tests')
    await user.click(screen.getByTestId('memory-search-submit'))
    const result = await screen.findByTestId('search-result')
    expect(within(result).getByTestId('search-result-score')).toHaveTextContent('0.812')
    expect(within(result).getByTestId('search-result-reasons')).toHaveTextContent('semantic match')
    const meters = within(within(result).getByTestId('search-result-breakdown')).getAllByRole('meter')
    expect(meters.map((m) => m.getAttribute('aria-label'))).toEqual(['Semantic', 'Lexical', 'Trust'])
    expect(screen.getByTestId('memory-search-trace')).toHaveAttribute(
      'href',
      '/traces/0192f0a0-0000-7000-8000-00000000e001',
    )
    const call = api.lastCall('POST', '/v1/memories/search')!
    expect(call.body).toMatchObject({ workspace_id: WS1, query: 'how to run tests', limit: 10 })
  })
})
