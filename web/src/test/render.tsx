import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { AppProviders } from '@/app/AppProviders'
import { AppRoutes } from '@/app/AppRoutes'
import type { StoredSession } from '@/auth/storage'
import { createQueryClient } from '@/lib/query-client'
import { WS1 } from './fixtures'

export const TEST_SESSION: StoredSession = { apiUrl: null, apiKey: 'mnm_testkey_secret', workspaceId: WS1 }

function testQueryClient() {
  const qc = createQueryClient()
  qc.setDefaultOptions({
    queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false, gcTime: Infinity },
    mutations: { retry: false },
  })
  return qc
}

export function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="location">{loc.pathname + loc.search}</div>
}

/** Render the full app (routes + layout guards) at `route`. */
export function renderApp(route: string, opts: { session?: StoredSession | null } = {}) {
  const session =
    opts.session === undefined
      ? TEST_SESSION
      : (opts.session ?? { apiUrl: null, apiKey: null, workspaceId: null })
  const queryClient = testQueryClient()
  const user = userEvent.setup()
  const utils = render(
    <MemoryRouter initialEntries={[route]}>
      <AppProviders queryClient={queryClient} initialSession={session}>
        <AppRoutes />
        <LocationProbe />
      </AppProviders>
    </MemoryRouter>,
  )
  return { ...utils, user, queryClient }
}

/** Render a single element inside providers (no layout guard), at a route with params. */
export function renderRoute(
  element: ReactElement,
  path: string,
  route: string,
  opts: { session?: StoredSession } = {},
) {
  const queryClient = testQueryClient()
  const user = userEvent.setup()
  const utils = render(
    <MemoryRouter initialEntries={[route]}>
      <AppProviders queryClient={queryClient} initialSession={opts.session ?? TEST_SESSION}>
        <Routes>
          <Route path={path} element={element} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  )
  return { ...utils, user, queryClient }
}
