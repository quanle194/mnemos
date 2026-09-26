import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SESSION_STORAGE_KEY } from '@/auth/storage'
import { me, page, stats, workspaces, WS2 } from '@/test/fixtures'
import { apiError, MockApi } from '@/test/mock-api'
import { renderApp } from '@/test/render'

function overviewMocks(api: MockApi) {
  return api.get('/v1/stats', { body: { ...stats, workspace_id: WS2 } }).get('/v1/audit-logs', page([]))
}

describe('login flow', () => {
  it('redirects to login, validates the key via /v1/me, picks a workspace and persists the session', async () => {
    const api = overviewMocks(new MockApi())
      .get('/v1/me', { body: me('maintainer') })
      .get('/v1/workspaces', { body: workspaces })
      .install()
    const { user } = renderApp('/memories', { session: null })

    // Guarded route sends us to the login screen.
    expect(await screen.findByTestId('login-form')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/login')

    await user.type(screen.getByTestId('login-api-key'), 'mnm_abcd1234_supersecret')
    await user.click(screen.getByTestId('login-submit'))

    // Workspace step lists workspaces from GET /v1/workspaces.
    const select = await screen.findByTestId('workspace-select')
    expect(screen.getByTestId('login-role')).toHaveTextContent('maintainer')
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['default', 'research'])
    const meCall = api.lastCall('GET', '/v1/me')!
    expect(meCall.headers.get('authorization')).toBe('Bearer mnm_abcd1234_supersecret')
    expect(meCall.url.pathname).toBe('/api/v1/me')

    await user.selectOptions(select, WS2)
    await user.click(screen.getByTestId('workspace-continue'))

    // Back to the originally requested page, inside the authenticated layout.
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/memories'))
    expect(await screen.findByTestId('workspace-switcher')).toHaveValue(WS2)
    expect(screen.getByTestId('current-role')).toHaveTextContent('maintainer')

    const stored = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) ?? '{}') as Record<string, unknown>
    expect(stored).toEqual({ apiUrl: null, apiKey: 'mnm_abcd1234_supersecret', workspaceId: WS2 })
  })

  it('uses a custom API URL when provided', async () => {
    const api = new MockApi()
      .get('/v1/me', { body: me('viewer') })
      .get('/v1/workspaces', { body: workspaces })
      .install()
    const { user } = renderApp('/login', { session: null })
    await user.type(await screen.findByTestId('login-api-key'), 'mnm_abcd1234_supersecret')
    await user.type(screen.getByTestId('login-api-url'), 'http://localhost:8000/')
    await user.click(screen.getByTestId('login-submit'))
    await screen.findByTestId('workspace-select')
    expect(api.lastCall('GET', '/v1/me')!.url.href).toBe('http://localhost:8000/v1/me')
  })

  it('shows a clear error for a rejected key and persists nothing', async () => {
    new MockApi().get('/v1/me', apiError(401, 'unauthorized', 'invalid api key')).install()
    const { user } = renderApp('/login', { session: null })
    await user.type(await screen.findByTestId('login-api-key'), 'mnm_wrong000_nope')
    await user.click(screen.getByTestId('login-submit'))
    expect(await screen.findByTestId('login-error')).toHaveTextContent('Invalid or revoked API key')
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
    expect(screen.queryByTestId('workspace-select')).not.toBeInTheDocument()
  })

  it('validates the form before calling the API', async () => {
    const api = new MockApi().install()
    const { user } = renderApp('/login', { session: null })
    await user.type(await screen.findByTestId('login-api-url'), 'not a url')
    await user.click(screen.getByTestId('login-submit'))
    expect(await screen.findByText(/Paste a Mnemos API key/)).toBeInTheDocument()
    expect(screen.getByText(/Use a path like \/api/)).toBeInTheDocument()
    expect(api.calls).toHaveLength(0)
  })

  it('signs out and clears the stored session', async () => {
    overviewMocks(new MockApi())
      .get('/v1/me', { body: me('admin') })
      .get('/v1/workspaces', { body: workspaces })
      .install()
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ apiKey: 'mnm_x_y', workspaceId: WS2 }))
    const { user } = renderApp('/')
    await user.click(await screen.findByTestId('logout-button'))
    expect(await screen.findByTestId('login-form')).toBeInTheDocument()
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull()
  })
})
