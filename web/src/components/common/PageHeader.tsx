import type { ReactNode } from 'react'

interface Props {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  'data-testid'?: string
}

export function PageHeader({ title, description, actions, ...rest }: Props) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3" data-testid={rest['data-testid']}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight break-words sm:text-2xl">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
