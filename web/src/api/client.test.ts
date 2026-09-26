import { describe, expect, it, vi } from 'vitest'
import { apiError, MockApi } from '@/test/mock-api'
import {
  ApiClient,
  ApiError,
  buildUrl,
  errorMessage,
  formatIfMatch,
  parseApiError,
  resolveApiUrl,
  uuidv4,
} from './client'
import {
  archiveMemory,
  getReadiness,
  listMemories,
  patchMemory,
  searchMemories,
  submitFeedback,
} from './endpoints'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function client(api: MockApi, apiKey: string | null = 'mnm_abc_secret') {
  return new ApiClient({ apiKey, fetchFn: api.fetch as unknown as typeof fetch })
}

describe('URL resolution', () => {
  it('defaults the API base to /api and strips trailing slashes', () => {
    expect(resolveApiUrl(null)).toBe('/api')
    expect(resolveApiUrl('')).toBe('/api')
    expect(resolveApiUrl('http://localhost:8000/')).toBe('http://localhost:8000')
    expect(new ApiClient().baseUrl).toBe('/api')
  })

  it('builds query strings, repeating arrays and skipping empty values', () => {
    expect(
      buildUrl('/api', '/v1/memories', {
        status: ['active', 'candidate'],
        q: '',
        layer: 3,
        cursor: undefined,
      }),
    ).toBe('/api/v1/memories?status=active&status=candidate&layer=3')
    expect(buildUrl('/api/', 'health/ready')).toBe('/api/health/ready')
  })
})

describe('ApiClient headers', () => {
  it('attaches the bearer key and JSON headers', async () => {
    const api = new MockApi().get('/v1/memories', { body: { items: [], next_cursor: null } })
    await listMemories(client(api), { workspace_id: 'ws-1', status: 'active', limit: 25 })
    const call = api.lastCall('GET', '/v1/memories')!
    expect(call.url.pathname).toBe('/api/v1/memories')
    expect(call.query.get('workspace_id')).toBe('ws-1')
    expect(call.query.get('status')).toBe('active')
    expect(call.query.get('limit')).toBe('25')
    expect(call.headers.get('authorization')).toBe('Bearer mnm_abc_secret')
    expect(call.headers.get('accept')).toBe('application/json')
    expect(call.headers.get('idempotency-key')).toBeNull()
  })

  it('omits Authorization when no key is configured', async () => {
    const api = new MockApi().get('/health/ready', { body: { status: 'ok', checks: {} } })
    await getReadiness(client(api, null))
    expect(api.lastCall('GET', '/health/ready')!.headers.get('authorization')).toBeNull()
  })

  it('generates a fresh UUID Idempotency-Key for every POST write', async () => {
    const api = new MockApi().post(/\/feedback$/, { status: 201, body: { feedback: {}, memory: {} } })
    const c = client(api)
    await submitFeedback(c, 'm1', { value: 'helpful' })
    await submitFeedback(c, 'm1', { value: 'helpful' })
    const [a, b] = api
      .callsTo('POST', '/v1/memories/m1/feedback')
      .map((r) => r.headers.get('idempotency-key'))
    expect(a).toMatch(UUID_V4)
    expect(b).toMatch(UUID_V4)
    expect(a).not.toBe(b)
    expect(api.lastCall('POST', '/v1/memories/m1/feedback')!.body).toEqual({ value: 'helpful' })
    expect(api.lastCall('POST', '/v1/memories/m1/feedback')!.headers.get('content-type')).toBe(
      'application/json',
    )
  })

  it('uses an explicit Idempotency-Key and can disable it for read-like POSTs', async () => {
    const api = new MockApi()
      .post('/v1/things', { body: {} })
      .post('/v1/memories/search', { body: { items: [], retrieval_trace_id: 't', weights: {} } })
    const c = client(api)
    await c.post('/v1/things', { a: 1 }, { idempotencyKey: 'fixed-key' })
    await searchMemories(c, { workspace_id: 'ws', query: 'q' })
    expect(api.lastCall('POST', '/v1/things')!.headers.get('idempotency-key')).toBe('fixed-key')
    expect(api.lastCall('POST', '/v1/memories/search')!.headers.get('idempotency-key')).toBeNull()
  })

  it('sends If-Match with the quoted memory version on PATCH and DELETE', async () => {
    const api = new MockApi().patch(/\/v1\/memories\//, { body: {} }).delete(/\/v1\/memories\//, { body: {} })
    const c = client(api)
    await patchMemory(c, 'm1', 7, { title: 'x' })
    await archiveMemory(c, 'm1', 8, 'cleanup')
    expect(api.lastCall('PATCH', '/v1/memories/m1')!.headers.get('if-match')).toBe('"7"')
    const del = api.lastCall('DELETE', '/v1/memories/m1')!
    expect(del.headers.get('if-match')).toBe('"8"')
    expect(del.query.get('reason')).toBe('cleanup')
    expect(formatIfMatch('"3"')).toBe('"3"')
    expect(formatIfMatch('W/"3"')).toBe('W/"3"')
  })
})

describe('error contract parsing', () => {
  it('turns {"error": {...}} into a typed ApiError with current_version for 409', async () => {
    const api = new MockApi().patch(
      '/v1/memories/m1',
      apiError(409, 'conflict', 'version mismatch', { current_version: 5, expected_version: 3 }),
    )
    const err = await patchMemory(client(api), 'm1', 3, { title: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    const e = err as ApiError
    expect(e.status).toBe(409)
    expect(e.code).toBe('conflict')
    expect(e.message).toBe('version mismatch')
    expect(e.requestId).toBe('req-test')
    expect(e.currentVersion).toBe(5)
    expect(e.isVersionConflict).toBe(true)
  })

  it('exposes 422 field errors and formats them for humans', () => {
    const e = parseApiError(422, {
      error: {
        code: 'validation_error',
        message: 'request validation failed',
        details: {
          errors: [
            { loc: ['body', 'importance'], msg: 'Input should be less than or equal to 1', type: 'x' },
          ],
        },
        request_id: 'r1',
      },
    })
    expect(e.fieldErrors).toHaveLength(1)
    expect(errorMessage(e)).toBe('importance: Input should be less than or equal to 1')
  })

  it('tolerates non-contract bodies (proxy text, FastAPI detail)', () => {
    const text = parseApiError(502, '<html>Bad gateway</html>', 'Bad Gateway')
    expect(text.status).toBe(502)
    expect(text.code).toBe('http_error')
    expect(text.message).toContain('Bad gateway')
    const detail = parseApiError(404, { detail: 'Not Found' })
    expect(detail.message).toBe('Not Found')
    const empty = parseApiError(500, undefined, 'Internal Server Error')
    expect(empty.message).toBe('HTTP 500 Internal Server Error')
    expect(empty.currentVersion).toBeNull()
  })

  it('maps network failures to ApiError status 0', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const c = new ApiClient({
      baseUrl: 'http://api.invalid',
      apiKey: 'k',
      fetchFn: failing as unknown as typeof fetch,
    })
    const err = (await c.get('/v1/me').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.isNetworkError).toBe(true)
    expect(err.code).toBe('network_error')
    expect(err.message).toContain('http://api.invalid')
  })

  it('returns bodies for accepted non-2xx statuses (readiness 503) and undefined for 204', async () => {
    const api = new MockApi()
      .get('/health/ready', {
        status: 503,
        body: { status: 'unavailable', checks: { redis: { ok: false } } },
      })
      .delete('/v1/working-memory/x', { status: 204 })
    const c = client(api)
    await expect(getReadiness(c)).resolves.toMatchObject({ status: 'unavailable' })
    await expect(c.delete('/v1/working-memory/x')).resolves.toBeUndefined()
  })
})

describe('uuidv4', () => {
  it('falls back to getRandomValues when randomUUID is unavailable (plain-HTTP deployments)', () => {
    const real = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) })
    const ids = new Set(Array.from({ length: 50 }, () => uuidv4()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(UUID_V4)
  })
})
