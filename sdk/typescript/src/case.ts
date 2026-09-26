/**
 * Key-case conversion between the SDK's camelCase surface and the API's snake_case wire format.
 *
 * Only *structural* keys are converted. Free-form maps whose keys are data (user metadata, score breakdowns, count
 * histograms, JSON snapshots) are copied verbatim so that e.g. `metadata: {"customer_id": 1}` round-trips unchanged.
 */

type Json = unknown;

/** Response keys (snake_case, as sent by the API) whose object value is a data map and must not be converted. */
const OPAQUE_RESPONSE_KEYS: ReadonlySet<string> = new Set([
  "metadata",
  "metadata_json",
  "payload_json",
  "snapshot_json",
  "settings_json",
  "result_json",
  "checkpoint_json",
  "input_window_json",
  "counters_json",
  "analysis_json",
  "resolution_json",
  "before_json",
  "after_json",
  "request_json",
  "candidates_json",
  "selected_json",
  "summary_json",
  "details",
  "scores",
  "weights",
  "evidence",
  "memories_by_status",
  "memories_by_type",
  "memories_by_layer",
  "experiences_by_outcome",
  "conflicts_by_status",
  "dreams_by_status",
  "jobs_by_status",
  "feedback_by_value",
  "queue",
]);

/** Request keys (camelCase, as written by SDK users) whose value is passed through verbatim. */
const OPAQUE_REQUEST_KEYS: ReadonlySet<string> = new Set(["metadata"]);

function isPlainObject(value: Json): value is Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

export function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** Deep-convert an API response (snake_case keys) to the SDK shape (camelCase keys). */
export function camelizeResponse(value: Json): unknown {
  return camelizeValue(value);
}

function camelizeValue(value: Json): Json {
  if (Array.isArray(value)) return value.map(camelizeValue);
  if (!isPlainObject(value)) return value;
  const out: Record<string, Json> = {};
  for (const [key, v] of Object.entries(value)) {
    out[snakeToCamel(key)] = OPAQUE_RESPONSE_KEYS.has(key) && isPlainObject(v) ? v : camelizeValue(v);
  }
  return out;
}

/**
 * Convert an SDK input object (camelCase keys) to an API request body (snake_case keys). `undefined` values are
 * dropped so server-side defaults apply; `null` is sent as JSON null. Values under opaque keys are sent verbatim.
 */
export function snakeizeRequest(value: Record<string, Json>): Record<string, Json> {
  return snakeizeValue(value) as Record<string, Json>;
}

function snakeizeValue(value: Json): Json {
  if (Array.isArray(value)) return value.map(snakeizeValue);
  if (value instanceof Date) return value.toISOString();
  if (!isPlainObject(value)) return value;
  const out: Record<string, Json> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    out[camelToSnake(key)] = OPAQUE_REQUEST_KEYS.has(key) ? v : snakeizeValue(v);
  }
  return out;
}
