import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface KeyValueItem {
  label: string
  value: ReactNode
  testId?: string
}

export function KeyValueGrid({ items, className }: { items: KeyValueItem[]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-4', className)}>
      {items.map((it) => (
        <div key={it.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{it.label}</dt>
          <dd className="mt-0.5 font-medium break-words" data-testid={it.testId}>
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
