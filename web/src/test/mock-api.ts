import { vi } from 'vitest'

export interface MockRequest {
  method: string
  url: URL
  /** Path relative to the API base (the `/api` prefix is stripped). */
  path: string
  query: URLSearchParams
  headers: Headers
  body: unknown
}

export interface MockReply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

export type MockHandler = (req: MockRequest) => MockReply | Promise<MockReply>

interface Route {
  method: string
  path: string | RegExp
  handler: MockHandler
  once: boolean
  used: boolean
}

/**
 * Tiny in-memory router standing in for the Mnemos API. Routes are matched most-recent-first, so tests can
 * override defaults (e.g. make one PATCH return 409). Unmatched requests return a 404 in the API's error format.
 */
export class MockApi {
  readonly calls: MockRequest[] = []
  private routes: Route[] = []
  readonly fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => this.handle(input, init))

  on(
    method: string,
    path: string | RegExp,
    reply: MockHandler | MockReply,
    opts: { once?: boolean } = {},
  ): this {
    const handler: MockHandler = typeof reply === 'function' ? reply : () => reply
    this.routes.unshift({
      method: method.toUpperCase(),
      path,
      handler,
      once: Boolean(opts.once),
      used: false,
    })
    return this
  }

  get(path: string | RegExp, reply: MockHandler | MockReply) {
    return this.on('GET', path, reply)
  }

  post(path: string | RegExp, reply: MockHandler | MockReply) {
    return this.on('POST', path, reply)
  }

  patch(path: string | RegExp, reply: MockHandler | MockReply) {
    return this.on('PATCH', path, reply)
  }

  delete(path: string | RegExp, reply: MockHandler | MockReply) {
    return this.on('DELETE', path, reply)
  }

  /** Install as global fetch (restored automatically by vi.unstubAllGlobals in setup). */
  install(): this {
    vi.stubGlobal('fetch', this.fetch)
    return this
  }

  callsTo(method: string, path: string | RegExp): MockRequest[] {
    return this.calls.filter(
      (c) =>
        c.method === method.toUpperCase() && (typeof path === 'string' ? c.path === path : path.test(c.path)),
    )
  }

  lastCall(method: string, path: string | RegExp): MockRequest | undefined {
    const all = this.callsTo(method, path)
    return all[all.length - 1]
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw, 'http://dashboard.test')
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname.replace(/^\/api(?=\/)/, '')
    let body: unknown = undefined
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = init.body
      }
    }
    const req: MockRequest = {
      method,
      url,
      path,
      query: url.searchParams,
      headers: new Headers(init?.headers),
      body,
    }
    this.calls.push(req)
    const route = this.routes.find(
      (r) =>
        !(r.once && r.used) &&
        r.method === method &&
        (typeof r.path === 'string' ? r.path === path : r.path.test(path)),
    )
    if (!route) {
      return json(404, {
        error: { code: 'not_found', message: `no mock for ${method} ${path}`, details: {}, request_id: null },
      })
    }
    route.used = true
    const reply = await route.handler(req)
    return json(reply.status ?? 200, reply.body, reply.headers)
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  if (status === 204 || body === undefined) return new Response(null, { status, headers })
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

export function apiError(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): MockReply {
  return { status, body: { error: { code, message, details, request_id: 'req-test' } } }
}
