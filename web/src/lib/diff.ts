export interface FieldChange {
  key: string
  before: unknown
  after: unknown
}

/** Fields hidden from the history diff (noise or internal). */
const IGNORED = new Set(['updated_at', 'embedding', 'content_hash'])

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Shallow diff between two memory version snapshots. Returns changed keys (sorted), including
 * keys added or removed between snapshots. `prev = null` means "first version": nothing to diff.
 */
export function diffSnapshots(
  prev: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
): FieldChange[] {
  if (!prev) return []
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)])
  const out: FieldChange[] = []
  for (const key of [...keys].sort()) {
    if (IGNORED.has(key)) continue
    if (!same(prev[key], next[key])) out.push({ key, before: prev[key], after: next[key] })
  }
  return out
}

export function displayValue(v: unknown, max = 160): string {
  if (v === undefined) return '∅'
  if (v === null) return 'null'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}
