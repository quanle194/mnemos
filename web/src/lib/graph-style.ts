import type { MemoryStatus, MemoryType } from '@/api/types'

export type ColorMode = 'status' | 'type'

export interface LegendEntry {
  key: string
  label: string
  color: string
  /** Non-retrievable statuses render hollow (secondary encoding, never color alone). */
  hollow?: boolean
}

/** Fixed entity -> color mapping (color follows the entity, never its rank). */
export const STATUS_LEGEND: LegendEntry[] = [
  { key: 'active', label: 'Active', color: 'var(--chart-1)' },
  { key: 'validated', label: 'Validated', color: 'var(--chart-3)' },
  { key: 'disputed', label: 'Disputed', color: 'var(--chart-2)' },
  { key: 'candidate', label: 'Candidate', color: 'var(--chart-4)', hollow: true },
  { key: 'superseded', label: 'Superseded', color: 'var(--chart-7)', hollow: true },
  { key: 'rejected', label: 'Rejected', color: 'var(--chart-8)', hollow: true },
  { key: 'archived', label: 'Archived', color: 'var(--muted-foreground)', hollow: true },
]

/** 13 memory types fold into 4 families (a categorical palette never exceeds its validated slots). */
export const TYPE_FAMILIES: Record<string, MemoryType[]> = {
  knowledge: ['fact', 'context', 'relationship', 'preference'],
  procedural: ['procedure'],
  policy: ['rule', 'constraint', 'decision'],
  experiential: ['lesson', 'pattern', 'success', 'failure', 'warning'],
}

export const TYPE_LEGEND: LegendEntry[] = [
  { key: 'knowledge', label: 'Facts & context', color: 'var(--chart-1)' },
  { key: 'procedural', label: 'Procedures', color: 'var(--chart-2)' },
  { key: 'policy', label: 'Rules & decisions', color: 'var(--chart-3)' },
  { key: 'experiential', label: 'Lessons & patterns', color: 'var(--chart-4)' },
]

export function typeFamily(type: string): string {
  for (const [family, types] of Object.entries(TYPE_FAMILIES)) {
    if ((types as string[]).includes(type)) return family
  }
  return 'knowledge'
}

const RETRIEVABLE = new Set<string>(['active', 'validated', 'disputed'])

export function nodeStyle(
  mode: ColorMode,
  node: { status: MemoryStatus | string; type: MemoryType | string },
) {
  const hollow = !RETRIEVABLE.has(node.status)
  if (mode === 'type') {
    const entry = TYPE_LEGEND.find((e) => e.key === typeFamily(node.type)) ?? TYPE_LEGEND[0]!
    return { color: entry.color, hollow }
  }
  const entry = STATUS_LEGEND.find((e) => e.key === node.status)
  return { color: entry?.color ?? 'var(--muted-foreground)', hollow }
}

export function nodeRadius(utility: number): number {
  const u = Number.isFinite(utility) ? Math.max(0, Math.min(1, utility)) : 0.5
  return 6 + 6 * u
}
