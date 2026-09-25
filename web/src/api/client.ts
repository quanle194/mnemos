import type { ErrorBody, JsonObject } from './types'

/** Default API base: production serves the API at `/api` behind the reverse proxy (prefix stripped). */
export const DEFAULT_API_URL = '/api'

export function envApiUrl(): string | undefined {
  const v = import.meta.env.VITE_API_URL as string | undefined
  return v && v.trim() ? v.trim() : undefined
}

/** Resolve the effective API base URL: explicit override -> VITE_API_URL -> `/api`. No trailing slash. */
export function resolveApiUrl(override?: string | null): string {
  const raw = (override && override.trim()) || envApiUrl() || DEFAULT_API_URL
  return raw.replace(/\/+$/, '') || DEFAULT_API_URL
}

/** RFC 4122 v4 UUID. Falls back to getRandomValues because crypto.randomUUID needs a secure context. */
export function uuidv4(): string {
  const c: Crypto | undefined = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID()
    } catch {
      // insecure context (plain-HTTP deployment): fall through
    }
  }
  const bytes = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export interface FieldError {
  loc: (string | number)[]
  msg: string
  type?: string
}

/** Typed representation of the API error contract `{"error": {code, message, details, request_id}}`. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: JsonObject
  readonly requestId: string | null

  constructor(status: number, body: ErrorBody) {
    super(body.message)
    this.name = 'ApiError'
    this.status = status
    this.code = body.code
    this.details = body.details ?? {}
    this.requestId = body.request_id ?? null
  }

  /** Server-reported current version for optimistic-concurrency conflicts (409). */
  get currentVersion(): number | null {
    const v = this.details.current_version
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
    return null
  }

  get isVersionConflict(): boolean {
    return this.status === 409 && this.currentVersion !== null
  }

  get isUnauthorized(): boolean {
    return this.status === 401
  }

  get isNetworkError(): boolean {
    return this.status === 0
  }

  /** Field-level validation errors (422 `details.errors`). */
  get fieldErrors(): FieldError[] {
    const errs = this.details.errors
    if (!Array.isArray(errs)) return []
    return errs.filter(
      (e): e is FieldError => typeof e === 'object' && e !== null && typeof (e as FieldError).msg === 'string',
    )
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse any error payload into an ApiError, tolerating non-contract bodies (proxies, FastAPI defaults). */
export function parseApiError(
  status: number,
  payload: unknown,
  statusText = '',
  requestIdHeader: string | null = null,
): ApiError {
  if (isRecord(payload) && isRecord(payload.error)) {
    const e = payload.error
    return new ApiError(status, {
      code: typeof e.code === 'string' ? e.code : 'error',
      message: typeof e.message === 'string' ? e.message : `HTTP ${status}`,
      details: isRecord(e.details) ? e.details : {},
      request_id: typeof e.request_id === 'string' ? e.request_id : requestIdHeader,
    })
  }
  if (isRecord(payload) && 'detail' in payload) {
    const d = payload.detail
    return new ApiError(status, {
      code: 'http_error',
      message: typeof d === 'string' ? d : `HTTP ${status}`,
      details: Array.isArray(d) ? { errors: d } : {},
      request_id: requestIdHeader,
    })
  }
  const text = typeof payload === 'string' && payload.trim() ? payload.trim().slice(0, 300) : ''
  return new ApiError(status, {
    code: 'http_error',
    message: text || `HTTP ${status}${statusText ? ` ${statusText}` : ''}`,
    details: {},
    request_id: requestIdHeader,
  })
}

export type QueryValue = string | number | boolean | null | undefined
export type QueryParams = Record<string, QueryValue | QueryValue[]>

export interface RequestOptions {
  query?: QueryParams
  body?: unknown
  /** Memory version for optimistic concurrency; sent as `If-Match: "<version>"`. */
  ifMatch?: number | string
  /** POST writes get a generated Idempotency-Key unless a key is given or `false` disables it. */
  idempotencyKey?: string | false
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Non-2xx statuses whose JSON body should be returned instead of thrown (e.g. readiness 503). */
  acceptStatuses?: number[]
}

export interface ApiClientConfig {
  baseUrl?: string | null
  apiKey?: string | null
  fetchFn?: typeof fetch
}

export function buildUrl(baseUrl: string, path: string, query?: QueryParams): string {
  const base = baseUrl.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  const search = new URLSearchParams()
  if (query) {
    for (const [key, raw] of Object.entries(query)) {
      const values = Array.isArray(raw) ? raw : [raw]
      for (const v of values) {
        if (v === undefined || v === null || v === '') continue
        search.append(key, String(v))
      }
    }
  }
  const qs = search.toString()
  return `${base}${p}${qs ? `?${qs}` : ''}`
}

export function formatIfMatch(v: number | string): string {
  const s = String(v).trim()
  return s.startsWith('"') || s.startsWith('W/') ? s : `"${s}"`
}

/** Minimal typed fetch wrapper: auth header, JSON bodies, error contract, If-Match and Idempotency-Key. */
export class ApiClient {
  readonly baseUrl: string
  readonly apiKey: string | null
  private readonly fetchFn?: typeof fetch

  constructor(config: ApiClientConfig = {}) {
    this.baseUrl = resolveApiUrl(config.baseUrl)
    this.apiKey = config.apiKey?.trim() || null
    this.fetchFn = config.fetchFn
  }

  url(path: string, query?: QueryParams): string {
    return buildUrl(this.baseUrl, path, query)
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const upper = method.toUpperCase()
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers }
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
    let body: BodyInit | undefined
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }
    if (opts.ifMatch !== undefined && opts.ifMatch !== null) headers['If-Match'] = formatIfMatch(opts.ifMatch)
    if (upper === 'POST' && opts.idempotencyKey !== false) {
      headers['Idempotency-Key'] = opts.idempotencyKey || uuidv4()
    }

    const doFetch = this.fetchFn ?? globalThis.fetch
    let res: Response
    try {
      res = await doFetch(this.url(path, opts.query), { method: upper, headers, body, signal: opts.signal })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      throw new ApiError(0, {
        code: 'network_error',
        message: `Cannot reach the Mnemos API at ${this.baseUrl}. Check the API URL and that the server is running.`,
        details: { cause: err instanceof Error ? err.message : String(err) },
        request_id: null,
      })
    }

    const payload = await readBody(res)
    if (res.ok || opts.acceptStatuses?.includes(res.status)) return payload as T
    throw parseApiError(res.status, payload, res.statusText, res.headers.get('x-request-id'))
  }

  get<T>(path: string, query?: QueryParams, opts: Omit<RequestOptions, 'query' | 'body'> = {}): Promise<T> {
    return this.request<T>('GET', path, { ...opts, query })
  }

  post<T>(path: string, body?: unknown, opts: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('POST', path, { ...opts, body })
  }

  patch<T>(path: string, body: unknown, opts: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('PATCH', path, { ...opts, body })
  }

  delete<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, opts)
  }
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined
  const text = await res.text()
  if (!text) return undefined
  const ct = res.headers.get('content-type') ?? ''
  if (ct.includes('json')) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/** Human-readable message for any thrown value (used by toasts and inline alerts). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const fields = err.fieldErrors
    if (err.status === 422 && fields.length > 0) {
      return fields
        .slice(0, 3)
        .map((f) => `${f.loc.filter((l) => l !== 'body').join('.') || 'request'}: ${f.msg}`)
        .join('; ')
    }
    return err.message
  }
  if (err instanceof Error) return err.message
  return String(err)
}
