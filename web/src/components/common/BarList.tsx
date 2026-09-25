import { formatNumber, humanize } from '@/lib/format'

interface Props {
  data: Record<string, number> | undefined
  /** Label formatter for keys (defaults to humanize). */
  formatLabel?: (key: string) => string
  emptyText?: string
  order?: readonly string[]
  'data-testid'?: string
}

/**
 * Horizontal bar list for a single measure: one hue, bars ≤ 12px, value at the tip, sorted by value unless an
 * explicit order is given. Every bar is labelled, so the list doubles as its own table view.
 */
export function BarList({ data, formatLabel = humanize, emptyText = 'No data yet', order, ...rest }: Props) {
  const entries = Object.entries(data ?? {}).filter(([, v]) => Number.isFinite(v))
  if (order) {
    const pos = (k: string) => {
      const i = order.indexOf(k)
      return i === -1 ? order.length : i
    }
    entries.sort((a, b) => pos(a[0]) - pos(b[0]) || b[1] - a[1])
  } else {
    entries.sort((a, b) => b[1] - a[1])
  }
  const max = Math.max(1, ...entries.map(([, v]) => v))
  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid={rest['data-testid']}>
        {emptyText}
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-2" data-testid={rest['data-testid']}>
      {entries.map(([key, value]) => (
        <li key={key} className="grid grid-cols-[7.5rem_1fr_3rem] items-center gap-2 text-sm" data-key={key}>
          <span className="truncate text-muted-foreground" title={formatLabel(key)}>
            {formatLabel(key)}
          </span>
          <span className="h-3 w-full" title={`${formatLabel(key)}: ${formatNumber(value)}`}>
            <span
              className="block h-3 rounded-r-[4px] bg-chart-1 transition-[width]"
              style={{ width: `${Math.max(2, (value / max) * 100)}%` }}
            />
          </span>
          <span className="tabular text-right font-medium">{formatNumber(value)}</span>
        </li>
      ))}
    </ul>
  )
}
