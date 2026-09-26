/**
 * Typed errors raised by the Mnemos SDK.
 *
 * Every error the SDK throws is a {@link MnemosError}. API errors follow the server's structured error contract
 * `{"error": {"code", "message", "details", "request_id"}}`; `details` is passed through verbatim (snake_case keys, as
 * sent by the server).
 */

export interface MnemosErrorInit {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown> | undefined;
  requestId?: string | undefined;
  cause?: unknown;
}

/** Base class for every SDK error. `status` is the HTTP status, or `0` for client-side failures (network/timeout). */
export class MnemosError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  readonly requestId: string | undefined;

  constructor(init: MnemosErrorInit) {
    super(`[${String(init.status)} ${init.code}] ${init.message}`, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? {};
    this.requestId = init.requestId;
  }
}

/** HTTP 401 (missing/invalid API key) or 403 (key lacks the permission or workspace scope). */
export class AuthError extends MnemosError {}

/** HTTP 404: the resource does not exist or is not visible to this API key's tenant. */
export class NotFoundError extends MnemosError {}

/**
 * HTTP 409: optimistic-concurrency version mismatch (`currentVersion` is set) or an Idempotency-Key reused with a
 * different payload (`code === "idempotency_key_reused"`).
 */
export class ConflictError extends MnemosError {
  /** The memory's current version on the server, when the conflict is a version mismatch. */
  readonly currentVersion: number | undefined;

  constructor(init: MnemosErrorInit & { currentVersion?: number | undefined }) {
    super(init);
    this.currentVersion = init.currentVersion;
  }
}

/** HTTP 422: request validation failed (`details.errors` lists the offending fields). */
export class ValidationError extends MnemosError {}

/** HTTP 429 after retries were exhausted (or the server asked to wait longer than `maxRetryDelayMs`). */
export class RateLimitError extends MnemosError {
  /** Server-requested wait before retrying, from the `Retry-After` header. */
  readonly retryAfterMs: number | undefined;

  constructor(init: MnemosErrorInit & { retryAfterMs?: number | undefined }) {
    super(init);
    this.retryAfterMs = init.retryAfterMs;
  }
}

/** The request never produced an HTTP response (DNS/connection failure, reset) after all retries. */
export class MnemosConnectionError extends MnemosError {}

/** A request exceeded `timeoutMs`, or `waitForLearning` did not observe completion before its deadline. */
export class MnemosTimeoutError extends MnemosError {}

function parseCurrentVersion(details: Record<string, unknown>, etag: string | null): number | undefined {
  const raw = details.current_version ?? (etag === null ? undefined : etag.replace(/^W\//, "").replace(/"/g, ""));
  if (raw === undefined || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build the typed error for a non-2xx response. `bodyText` is the raw response body. */
export function errorFromResponse(
  status: number,
  bodyText: string,
  headers: { get(name: string): string | null },
  retryAfterMs?: number,
): MnemosError {
  let err: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isRecord(parsed) && isRecord(parsed.error)) err = parsed.error;
  } catch {
    // Non-JSON body (e.g. a proxy error page): fall back to the raw text below.
  }
  const init: MnemosErrorInit = {
    status,
    code: typeof err.code === "string" ? err.code : "error",
    message: typeof err.message === "string" ? err.message : bodyText.slice(0, 300) || `HTTP ${String(status)}`,
    details: isRecord(err.details) ? err.details : {},
    requestId: typeof err.request_id === "string" ? err.request_id : (headers.get("x-request-id") ?? undefined),
  };
  switch (status) {
    case 401:
    case 403:
      return new AuthError(init);
    case 404:
      return new NotFoundError(init);
    case 409:
      return new ConflictError({ ...init, currentVersion: parseCurrentVersion(init.details ?? {}, headers.get("etag")) });
    case 422:
      return new ValidationError(init);
    case 429:
      return new RateLimitError({ ...init, retryAfterMs });
    default:
      return new MnemosError(init);
  }
}
