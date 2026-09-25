import { cn } from '@/lib/utils'

interface Props {
  value: unknown
  className?: string
  maxHeight?: string
  'data-testid'?: string
}

export function JsonView({ value, className, maxHeight = 'max-h-80', ...rest }: Props) {
  const empty =
    value === null ||
    value === undefined ||
    (typeof value === 'object' && Object.keys(value as object).length === 0)
  return (
    <pre
      className={cn(
        'overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap',
        maxHeight,
        className,
      )}
      data-testid={rest['data-testid']}
    >
      {empty ? '{}' : JSON.stringify(value, null, 2)}
    </pre>
  )
}
