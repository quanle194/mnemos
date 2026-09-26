import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { conflict, memory, MEM1, MEM2, withSession } from '@/test/fixtures'
import { MockApi } from '@/test/mock-api'
import { renderApp } from '@/test/render'

const C = conflict()
const PATH = `/v1/conflicts/${C.id}`

describe('Conflict detail', () => {
  it('shows candidate vs existing side by side with the analysis', async () => {
    withSession(new MockApi()).get(PATH, { body: C }).install()
    renderApp(`/conflicts/${C.id}`)
    const candidate = await screen.findByTestId('conflict-candidate')
    const existing = screen.getByTestId('conflict-existing')
    expect(candidate).toHaveTextContent('Never run migrations in tests')
    expect(within(candidate).getByTestId('conflict-candidate-status')).toHaveAttribute(
      'data-status',
      'disputed',
    )
    expect(within(candidate).getByRole('link', { name: /Never run migrations/ })).toHaveAttribute(
      'href',
      `/memories/${MEM2}`,
    )
    expect(existing).toHaveTextContent('Run migrations before tests')
    expect(within(existing).getByRole('link', { name: /Run migrations before tests/ })).toHaveAttribute(
      'href',
      `/memories/${MEM1}`,
    )
    expect(screen.getByTestId('conflict-judgment')).toHaveTextContent('opposite instructions')
    expect(screen.getByTestId('conflict-analysis')).toHaveTextContent('"similarity": 0.91')
  })

  it('resolves the conflict and renders the resolution', async () => {
    let current = C
    const api = withSession(new MockApi())
      .get(PATH, () => ({ body: current }))
      .post(`${PATH}/resolve`, (req) => {
        current = conflict({
          status: 'resolved',
          resolved_at: '2026-09-25T13:00:00Z',
          resolution_json: {
            resolution: 'accept_candidate',
            note: 'newer policy',
            by: 'api_key:key-admin',
            auto: false,
          },
          candidate: memory({
            id: MEM2,
            title: 'Never run migrations in tests',
            status: 'active',
            version: 2,
          }),
          existing: memory({ status: 'superseded', version: 4 }),
        })
        expect(req.body).toEqual({ resolution: 'accept_candidate', note: 'newer policy' })
        return { body: current }
      })
      .install()
    const { user } = renderApp(`/conflicts/${C.id}`)
    await user.type(await screen.findByTestId('conflict-note'), 'newer policy')
    await user.click(screen.getByTestId('conflict-resolve-accept_candidate'))

    await waitFor(() => expect(api.callsTo('POST', `${PATH}/resolve`)).toHaveLength(1))
    expect(await screen.findByTestId('conflict-resolution')).toHaveTextContent('Accept candidate')
    expect(screen.getByTestId('conflict-status')).toHaveAttribute('data-status', 'resolved')
    expect(screen.getByTestId('conflict-existing-status')).toHaveAttribute('data-status', 'superseded')
    expect(screen.queryByTestId('conflict-resolve')).not.toBeInTheDocument()
  })

  it('hides resolve actions without memory:review', async () => {
    withSession(new MockApi(), 'agent').get(PATH, { body: C }).install()
    renderApp(`/conflicts/${C.id}`)
    await screen.findByTestId('conflict-candidate')
    expect(await screen.findByText(/requires the memory:review permission/)).toBeInTheDocument()
    expect(screen.queryByTestId('conflict-resolve-keep_existing')).not.toBeInTheDocument()
  })
})
