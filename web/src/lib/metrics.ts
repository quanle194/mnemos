export type MetricKind = 'measured' | 'estimated' | 'unlabelled'

export interface Metric {
  key: string
  value: unknown
  kind: MetricKind
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function kindFromKey(key: string): MetricKind | null {
  const k = key.toLowerCase()
  if (/(^|[_\s.-])(estimated?|estimates|est)([_\s.-]|$)/.test(k) || k.startsWith('estimated'))
    return 'estimated'
  if (/(^|[_\s.-])measured([_\s.-]|$)/.test(k)) return 'measured'
  return null
}

/**
 * Flatten an eval `summary_json` into labelled metrics. Recognised conventions (the eval harness
 * labels estimates explicitly; never present an estimate as a measurement):
 *   {measured: {...}, estimated: {...}}            -> group objects
 *   {"x": {value, kind|type|basis: "estimated"}}    -> per-metric labels
 *   {"tokens_saved_estimate": 12}                  -> key-name labels
 */
export function classifyMetrics(summary: Record<string, unknown> | null | undefined): Metric[] {
  if (!summary) return []
  const out: Metric[] = []
  const visit = (obj: Record<string, unknown>, prefix: string, inherited: MetricKind | null) => {
    for (const [rawKey, value] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${rawKey}` : rawKey
      const groupKind = kindFromKey(rawKey)
      if (isRecord(value)) {
        const label = value.kind ?? value.type ?? value.basis ?? value.label
        if (
          'value' in value &&
          typeof label === 'string' &&
          (label === 'measured' || label === 'estimated')
        ) {
          out.push({ key, value: value.value, kind: label })
          continue
        }
        if ('value' in value && typeof value.estimated === 'boolean') {
          out.push({ key, value: value.value, kind: value.estimated ? 'estimated' : 'measured' })
          continue
        }
        // Group objects named measured/estimated label everything under them.
        if (rawKey === 'measured' || rawKey === 'estimated') {
          visit(value, prefix, rawKey)
          continue
        }
        visit(value, key, groupKind ?? inherited)
        continue
      }
      out.push({ key, value, kind: groupKind ?? inherited ?? 'unlabelled' })
    }
  }
  visit(summary, '', null)
  return out
}

export function formatMetricValue(v: unknown): string {
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v)
    return Math.abs(v) < 1 ? v.toFixed(3) : v.toFixed(2)
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  return JSON.stringify(v)
}
