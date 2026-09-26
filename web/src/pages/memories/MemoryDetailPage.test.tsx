import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Role } from '@/api/types'
import {
  EXP1,
  evidence,
  feedback,
  history,
  MEM1,
  MEM2,
  memory,
  relations,
  usage,
  withSession,
} from '@/test/fixtures'
import { apiError, MockApi } from '@/test/mock-api'
import { renderApp } from '@/test/render'

const BASE = `/v1/memories/${MEM1}`

function detailApi(role: Role = 'admin') {
  return withSession(new MockApi(), role)
    .get(BASE, { body: memory() })
    .get(`${BASE}/evidence`, { body: evidence })
    .get(`${BASE}/history`, { body: history })
    .get(`${BASE}/relations`, { body: relations })
    .get(`${BASE}/usage`, { body: usage })
    .get(`${BASE}/feedback`, { body: feedback })
}

describe('Memory detail', () => {
  it('exposes properties, evidence with source summary, history, relations, usage and feedback', async () => {
    detailApi().install()
    renderApp(`/memories/${MEM1}`)

    const detail = await screen.findByTestId('memory-detail')
    expect(within(detail).getByTestId('memory-title')).toHaveTextContent('Run migrations before tests')
    expect(screen.getByTestId('memory-status-badge')).toHaveAttribute('data-status', 'active')
    expect(screen.getByTestId('memory-version')).toHaveTextContent('3')
    expect(screen.getByTestId('memory-prop-scope')).toHaveTextContent('Workspace')
    expect(screen.getByTestId('memory-prop-valid-until')).toHaveTextContent('No expiry')
    expect(screen.getByTestId('memory-content')).toHaveTextContent('make migrate')
    const trust = within(screen.getByTestId('memory-trust')).getAllByRole('meter')
    expect(trust.map((m) => m.getAttribute('aria-label'))).toEqual([
      'Confidence',
      'Source trust',
      'Importance',
      'Utility',
    ])

    // Evidence: "why does Mnemos believe this?"
    const ev = await screen.findByTestId('evidence-row')
    const source = within(ev).getByTestId('evidence-source')
    expect(within(source).getByRole('link')).toHaveAttribute('href', `/experiences/${EXP1}`)
    expect(source).toHaveTextContent('Run the integration tests')
    expect(source).toHaveTextContent('ran make migrate')
    expect(within(ev).getByTestId('evidence-excerpt')).toHaveTextContent('running migrations fixed it')

    // History newest first with reason, actor and a diff against the previous snapshot.
    const versions = await screen.findAllByTestId('history-row')
    expect(versions.map((v) => v.getAttribute('data-version'))).toEqual(['3', '2', '1'])
    expect(within(versions[0]!).getByTestId('history-reason')).toHaveTextContent('manual edit')
    expect(within(versions[0]!).getByTestId('history-actor')).toHaveTextContent('api_key:key-admin')
    const diff = within(versions[0]!).getByTestId('history-diff')
    expect(diff).toHaveTextContent('title')
    expect(diff).toHaveTextContent('Run migrations')
    expect(diff).toHaveTextContent('Run migrations before tests')
    expect(within(versions[1]!).getByTestId('history-diff')).toHaveTextContent('status')

    const rel = await screen.findByTestId('relation-row')
    expect(rel).toHaveAttribute('data-relation', 'supersedes')
    expect(within(rel).getByTestId('relation-link')).toHaveAttribute('href', `/memories/${MEM2}`)

    expect(await screen.findByTestId('usage-row')).toHaveTextContent('how to run tests')
    expect(await screen.findByTestId('feedback-row')).toHaveTextContent('saved a debugging session')
  })

  it('submits feedback and refreshes the memory', async () => {
    const api = detailApi()
      .post(`${BASE}/feedback`, {
        status: 201,
        body: {
          feedback: { ...feedback[0], id: 'fb-2', value: 'outdated', note: 'API changed' },
          memory: {
            utility_score: 0.5,
            trust_score: 0.7,
            status: 'active',
            lifecycle_action: null,
            counts: {},
          },
        },
      })
      .install()
    const { user } = renderApp(`/memories/${MEM1}`)
    const form = await screen.findByTestId('feedback-form')
    expect(screen.getByTestId('feedback-submit')).toBeDisabled()

    await user.click(within(form).getByTestId('feedback-value-outdated'))
    await user.type(within(form).getByTestId('feedback-note'), 'API changed')
    const memoryFetchesBefore = api.callsTo('GET', BASE).length
    await user.click(screen.getByTestId('feedback-submit'))

    await waitFor(() => expect(api.callsTo('POST', `${BASE}/feedback`)).toHaveLength(1))
    const call = api.lastCall('POST', `${BASE}/feedback`)!
    expect(call.body).toEqual({ value: 'outdated', note: 'API changed' })
    expect(call.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
    expect(await screen.findByText(/Feedback recorded: outdated/)).toBeInTheDocument()
    // Cache invalidation: memory detail and feedback list are refetched.
    await waitFor(() => expect(api.callsTo('GET', BASE).length).toBeGreaterThan(memoryFetchesBefore))
    await waitFor(() => expect(api.callsTo('GET', `${BASE}/feedback`).length).toBeGreaterThan(1))
    expect(screen.getByTestId('feedback-submit')).toBeDisabled()
  })

  it('handles a PATCH 409 version conflict: explains it, offers reload, then saves on the new version', async () => {
    let serverVersion = 4
    const api = detailApi()
      .patch(BASE, (req) => {
        const expected = Number(String(req.headers.get('if-match')).replaceAll('"', ''))
        if (expected !== serverVersion) {
          return apiError(409, 'conflict', 'version mismatch', {
            current_version: serverVersion,
            expected_version: expected,
          })
        }
        serverVersion += 1
        return { body: memory({ ...(req.body as object), version: serverVersion }) }
      })
      .install()
    const { user } = renderApp(`/memories/${MEM1}`)

    await user.click(await screen.findByTestId('memory-edit-button'))
    const form = await screen.findByTestId('memory-edit-form')
    expect(screen.getByTestId('memory-edit-base-version')).toHaveTextContent('3')
    const title = within(form).getByTestId('memory-edit-title')
    await user.clear(title)
    await user.type(title, 'Run migrations before every test run')
    await user.click(screen.getByTestId('memory-edit-submit'))

    const alert = await screen.findByTestId('memory-conflict-alert')
    expect(alert).toHaveTextContent('version 4')
    expect(alert).toHaveTextContent('you edited version 3')
    const first = api.lastCall('PATCH', BASE)!
    expect(first.headers.get('if-match')).toBe('"3"')
    expect(first.body).toEqual({
      title: 'Run migrations before every test run',
      reason: 'edited via dashboard',
    })
    expect(screen.getByTestId('memory-edit-submit')).toBeDisabled()

    // Someone else's change is now on the server; reloading shows it and rebases the edit on version 4.
    api.get(BASE, { body: memory({ title: 'Run migrations first', version: 4 }) })
    await user.click(screen.getByTestId('memory-conflict-reload'))
    await waitFor(() => expect(screen.queryByTestId('memory-conflict-alert')).not.toBeInTheDocument())
    expect(screen.getByTestId('memory-edit-base-version')).toHaveTextContent('4')
    expect(within(form).getByTestId('memory-edit-title')).toHaveValue('Run migrations first')

    await user.clear(within(form).getByTestId('memory-edit-importance'))
    await user.type(within(form).getByTestId('memory-edit-importance'), '0.9')
    await user.click(screen.getByTestId('memory-edit-submit'))
    await waitFor(() => expect(screen.queryByTestId('memory-edit-form')).not.toBeInTheDocument())
    const second = api.lastCall('PATCH', BASE)!
    expect(second.headers.get('if-match')).toBe('"4"')
    expect(second.body).toEqual({ importance: 0.9, reason: 'edited via dashboard' })
    expect(await screen.findByText('Saved as version 5')).toBeInTheDocument()
  })

  it('rejects out-of-range edits client-side without calling the API', async () => {
    const api = detailApi().install()
    const { user } = renderApp(`/memories/${MEM1}`)
    await user.click(await screen.findByTestId('memory-edit-button'))
    const form = await screen.findByTestId('memory-edit-form')
    await user.clear(within(form).getByTestId('memory-edit-confidence'))
    await user.type(within(form).getByTestId('memory-edit-confidence'), '1.5')
    await user.click(screen.getByTestId('memory-edit-submit'))
    expect(await within(form).findByText('Confidence must be ≤ 1')).toBeInTheDocument()
    expect(api.callsTo('PATCH', BASE)).toHaveLength(0)
  })

  it('offers approve/reject for pending candidates to reviewers and sends the expected version', async () => {
    let current = memory({ status: 'candidate', review_state: 'pending', version: 2 })
    const api = detailApi()
      .get(BASE, () => ({ body: current }))
      .post(`${BASE}/review`, () => {
        current = memory({ status: 'active', review_state: 'approved', version: 3 })
        return { body: current }
      })
      .install()
    const { user } = renderApp(`/memories/${MEM1}`)
    await user.click(await screen.findByTestId('memory-approve-button'))
    await user.type(await screen.findByTestId('memory-review-note'), 'verified')
    await user.click(screen.getByTestId('memory-review-dialog-confirm'))
    await waitFor(() => expect(api.callsTo('POST', `${BASE}/review`)).toHaveLength(1))
    expect(api.lastCall('POST', `${BASE}/review`)!.body).toEqual({
      approve: true,
      note: 'verified',
      expected_version: 2,
    })
    await waitFor(() =>
      expect(screen.getByTestId('memory-status-badge')).toHaveAttribute('data-status', 'active'),
    )
    expect(screen.queryByTestId('memory-approve-button')).not.toBeInTheDocument()
  })

  it('hides mutations the role lacks (viewer)', async () => {
    detailApi('viewer').install()
    renderApp(`/memories/${MEM1}`)
    await screen.findByTestId('memory-detail')
    await screen.findByTestId('feedback-row')
    expect(screen.queryByTestId('memory-edit-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('memory-archive-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('memory-promote-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('feedback-form')).not.toBeInTheDocument()
  })

  it('archives with If-Match and shows the new status', async () => {
    let current = memory()
    const api = detailApi()
      .get(BASE, () => ({ body: current }))
      .delete(BASE, () => {
        current = memory({ status: 'archived', version: 4 })
        return { body: current }
      })
      .install()
    const { user } = renderApp(`/memories/${MEM1}`)
    await user.click(await screen.findByTestId('memory-archive-button'))
    await user.click(await screen.findByTestId('memory-archive-dialog-confirm'))
    await waitFor(() =>
      expect(screen.getByTestId('memory-status-badge')).toHaveAttribute('data-status', 'archived'),
    )
    const call = api.lastCall('DELETE', BASE)!
    expect(call.headers.get('if-match')).toBe('"3"')
    expect(call.query.get('reason')).toBe('archived via dashboard')
  })
})
