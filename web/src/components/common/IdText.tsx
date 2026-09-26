import { shortId } from '@/lib/format'
import { cn } from '@/lib/utils'

export function IdText({ id, className }: { id: string | null | undefined; className?: string }) {
  return (
    <span className={cn('font-mono text-xs', className)} title={id ?? undefined}>
      {shortId(id)}
    </span>
  )
}
