import type { BadgeVariant } from '@/components/ui/badge'

const MEMORY: Record<string, BadgeVariant> = {
  candidate: 'info',
  validated: 'secondary',
  active: 'success',
  disputed: 'warning',
  superseded: 'muted',
  archived: 'muted',
  rejected: 'destructive',
}
const DREAM: Record<string, BadgeVariant> = {
  queued: 'muted',
  running: 'info',
  succeeded: 'success',
  failed: 'destructive',
}
const JOB: Record<string, BadgeVariant> = { ...DREAM, failed: 'warning', dead: 'destructive' }
const CONFLICT: Record<string, BadgeVariant> = { open: 'warning', resolved: 'success' }
const PROCESSING: Record<string, BadgeVariant> = { pending: 'info', processed: 'success', failed: 'destructive' }
const OUTCOME: Record<string, BadgeVariant> = {
  success: 'success',
  failure: 'destructive',
  partial: 'warning',
  unknown: 'muted',
}
const FEEDBACK: Record<string, BadgeVariant> = {
  helpful: 'success',
  irrelevant: 'muted',
  incorrect: 'destructive',
  outdated: 'warning',
  harmful: 'destructive',
}
const REVIEW: Record<string, BadgeVariant> = {
  none: 'muted',
  pending: 'warning',
  approved: 'success',
  rejected: 'destructive',
}

const TABLES = {
  memory: MEMORY,
  dream: DREAM,
  job: JOB,
  conflict: CONFLICT,
  processing: PROCESSING,
  outcome: OUTCOME,
  feedback: FEEDBACK,
  review: REVIEW,
} as const

export type StatusKind = keyof typeof TABLES

export function statusVariant(kind: StatusKind, value: string | null | undefined): BadgeVariant {
  if (!value) return 'muted'
  return TABLES[kind][value] ?? 'outline'
}
