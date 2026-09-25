import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MEM2, memory, page, withSession, WS1 } from '@/test/fixtures'
import { MockApi } from '@/test/mock-api'
import { renderApp } from '@/test/render'
import { proposeMemorySchema } from './memory-schemas'

function api(role: 'agent' | 'admin' = 'agent') {
  return withSession(new MockApi(), role)
    .get('/v1/memories', page([]))
    .get(`/v1/workspaces/${WS1}/projects`, {
      body: [{ id: 'p1', workspace_id: WS1, name: 'api', created_at: '2026-01-01T00:00:00Z' }],
    })
    .get(`/v1/workspaces/${WS1}/agents`, { body: [] })
}

describe('Propose memory', () => {
  it('requires a project name for project scope (schema)', () => {
    const r = proposeMemorySchema.safeParse({
      title: 't',
      content: 'c',
      type: 'fact',
      scope_type: 'project',
      project_name: '',
      agent_name: '',
      confidence: 0.6,
      importance: 0.5,
      layer: '3',
      status: 'candidate',
      valid_until: '',
    })
    expect(r.success).toBe(false)
    expect(r.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['project_name', 'Project scope needs a project name'],
    ])
  })

  it('disables reviewer-only options for agents and posts a candidate proposal', async () => {
    const mock = api('agent')
      .post('/v1/memories', { status: 201, body: memory({ id: MEM2, status: 'candidate', version: 1 }) })
      .get(`/v1/memories/${MEM2}`, { body: memory({ id: MEM2, status: 'candidate', version: 1 }) })
      .install()
    const { user } = renderApp('/memories')
    await user.click(await screen.findByTestId('propose-memory-open'))
    const form = await screen.findByTestId('propose-memory-form')
    expect(within(form).getByRole('option', { name: /Active/ })).toBeDisabled()
    expect(within(form).getByRole('option', { name: /L4 organizational/ })).toBeDisabled()
    expect(within(form).getByRole('option', { name: /Organization/ })).toBeDisabled()

    await user.click(within(form).getByTestId('propose-memory-submit'))
    expect(await within(form).findByText('Title is required')).toBeInTheDocument()
    expect(mock.callsTo('POST', '/v1/memories')).toHaveLength(0)

    await user.type(within(form).getByTestId('propose-memory-title'), 'Use npm ci in CI')
    await user.type(within(form).getByTestId('propose-memory-content'), 'CI installs web deps with npm ci.')
    await user.selectOptions(within(form).getByTestId('propose-memory-type'), 'procedure')
    await user.selectOptions(within(form).getByTestId('propose-memory-scope'), 'project')
    await user.click(within(form).getByTestId('propose-memory-submit'))
    expect(await within(form).findByText('Project scope needs a project name')).toBeInTheDocument()
    await user.type(within(form).getByTestId('propose-memory-project'), 'api')
    await user.click(within(form).getByTestId('propose-memory-submit'))

    await waitFor(() => expect(mock.callsTo('POST', '/v1/memories')).toHaveLength(1))
    expect(mock.lastCall('POST', '/v1/memories')!.body).toEqual({
      workspace_id: WS1,
      title: 'Use npm ci in CI',
      content: 'CI installs web deps with npm ci.',
      type: 'procedure',
      scope_type: 'project',
      project_name: 'api',
      agent_name: null,
      confidence: 0.6,
      importance: 0.5,
      layer: 3,
      status: 'candidate',
      valid_until: null,
    })
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/memories/${MEM2}`))
  })

  it('is not offered to viewers', async () => {
    withSession(new MockApi(), 'viewer').get('/v1/memories', page([])).install()
    renderApp('/memories')
    await screen.findByTestId('empty-state')
    expect(screen.queryByTestId('propose-memory-open')).not.toBeInTheDocument()
  })
})
