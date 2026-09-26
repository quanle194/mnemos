import { Badge } from '@/components/ui/badge'
import { humanize } from '@/lib/format'
import { statusVariant, type StatusKind } from '@/lib/status'
import { cn } from '@/lib/utils'

interface Props {
  kind: StatusKind
  value: string | null | undefined
  className?: string
  'data-testid'?: string
}

/** Status pill: always text + color (never color alone). `data-status` carries the raw value for tests. */
export function StatusBadge({ kind, value, className, ...rest }: Props) {
  return (
    <Badge
      variant={statusVariant(kind, value)}
      className={cn('capitalize', className)}
      data-status={value ?? ''}
      data-testid={rest['data-testid']}
    >
      {value ? humanize(value) : '—'}
    </Badge>
  )
}
