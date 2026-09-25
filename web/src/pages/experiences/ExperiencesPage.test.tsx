import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EXP1, experience, MEM1, page, withSession, WS1 } from '@/test/fixtures'
import { MockApi } from '@/test/mock-api'
import { renderApp } from '@/test/render'

function api() {
  return withSession(new MockApi(), 'agent')
    .get('/v1/experiences', page([experience({ processing_status: 'processed' })]))
    .get(`/v1/workspaces/${WS1}/projects`, { body: [] })
    .get(`/v1/workspaces/${WS1}/agents`, { body: [] })
}

describe('Experiences', () => {
  it('lists experiences with outcome and learning status', async () => {
    api().install()
    renderApp('/experiences')
    const row = await screen.findByTestId('experience-row')
    expect(row).toHaveTextContent('Run the integration tests')
    expect(within(row).getByText('Processed')).toBeInTheDocument()
    expect(within(row).getByText('Success')).toBeInTheDocument()
  })

  it('validates the form with Zod before posting', async () => {
    const mock = api().install()
    const { user } = renderApp('/experiences')
    await user.click(await screen.findByTestId('experience-create-open'))
    const form = await screen.findByTestId('experience-form')
    const importance = within(form).getByTestId('experience-importance')
    await user.clear(importance)
    await user.type(importance, '3')
    await user.click(within(form).getByTestId('experience-submit'))
    expect(await within(form).findByText('Task is required')).toBeInTheDocument()
    expect(within(form).getByText('Importance must be ≤ 1')).toBeInTheDocument()
    expect(within(form).getByTestId('experience-task')).toHaveAttribute('aria-invalid', 'true')
    expect(mock.callsTo('POST', '/v1/experiences')).toHaveLength(0)
  })

  it('records an experience and opens its detail page, which polls learning status until processed', async () => {
    let polls = 0
    const mock = api()
      .post('/v1/experiences', {
        status: 201,
        body: {
          experience: experience(),
          learning: { job_id: 'job-1', job_status: 'queued', processing_status: 'pending', memories: [] },
        },
      })
      .get(`/v1/experiences/${EXP1}`, () => {
        polls += 1
        const done = polls > 1
        return {
          body: {
            ...experience({ processing_status: done ? 'processed' : 'pending' }),
            learning: {
              job_id: 'job-1',
              job_status: done ? 'succeeded' : 'running',
              processing_status: done ? 'processed' : 'pending',
              memories: done
                ? [{ id: MEM1, title: 'Run migrations before tests', status: 'candidate', type: 'rule' }]
                : [],
            },
          },
        }
      })
      .install()
    const { user } = renderApp('/experiences')
    await user.click(await screen.findByTestId('experience-create-open'))
    const form = await screen.findByTestId('experience-form')
    await user.type(within(form).getByTestId('experience-task'), 'Run the integration tests')
    await user.type(within(form).getByTestId('experience-result'), 'tests passed')
    await user.selectOptions(within(form).getByTestId('experience-outcome'), 'partial')
    await user.type(within(form).getByTestId('experience-agent-name'), 'ci-bot')
    await user.click(within(form).getByTestId('experience-submit'))

    await waitFor(() => expect(mock.callsTo('POST', '/v1/experiences')).toHaveLength(1))
    const call = mock.lastCall('POST', '/v1/experiences')!
    expect(call.body).toMatchObject({
      workspace_id: WS1,
      task: 'Run the integration tests',
      result: 'tests passed',
      outcome: 'partial',
      agent_name: 'ci-bot',
      project_name: null,
      importance: 0.5,
      confidence: 0.7,
      source: 'agent',
    })
    expect(call.headers.get('idempotency-key')).toBeTruthy()

    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/experiences/${EXP1}`))
    expect(await screen.findByTestId('experience-processing-status')).toHaveAttribute(
      'data-status',
      'pending',
    )
    // Polling (2s) picks up the processed state and the derived memory.
    const derived = await screen.findByTestId('experience-derived-memory', {}, { timeout: 4000 })
    expect(within(derived).getByRole('link')).toHaveAttribute('href', `/memories/${MEM1}`)
    expect(screen.getByTestId('experience-processing-status')).toHaveAttribute('data-status', 'processed')
    const pollsAtDone = polls
    await new Promise((r) => setTimeout(r, 2300))
    expect(polls).toBe(pollsAtDone)
  }, 12_000)
})
