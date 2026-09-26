import * as React from 'react'
import { cn } from '@/lib/utils'

export function Checkbox({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type'>) {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn('size-4 shrink-0 rounded border border-input accent-primary', className)}
      {...props}
    />
  )
}
