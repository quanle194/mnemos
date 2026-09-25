import { formatScore } from '@/lib/format'
import { cn } from '@/lib/utils'

interface Props {
  label: string
  value: number
  /** Upper bound of the scale (scores are 0..1 unless stated). */
  max?: number
  className?: string
}

/** Meter for a single 0..1 score: filled track in the accent hue, value as text (never color alone). */
export function ScoreBar({ label, value, max = 1, className }: Props) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100))
  return (
    <div className={cn('flex items-center gap-2 text-xs', className)} title={`${label}: ${formatScore(value, 3)}`}>
      <span className="w-24 shrink-0 truncate text-muted-foreground">{label}</span>
      <div
        className="h-2 flex-1 overflow-hidden rounded-full bg-chart-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
      >
        <div className="h-full rounded-full bg-chart-1" style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular w-10 shrink-0 text-right">{formatScore(value)}</span>
    </div>
  )
}
