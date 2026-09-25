import type { ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface Props {
  title: string
  description?: ReactNode
  count?: number
  actions?: ReactNode
  children: ReactNode
  testId: string
}

export function Section({ title, description, count, actions, children, testId }: Props) {
  return (
    <Card data-testid={testId} aria-labelledby={`${testId}-title`}>
      <CardHeader>
        <div>
          <CardTitle id={`${testId}-title`} className="text-base">
            {title}
            {count !== undefined ? (
              <span className="ml-2 text-sm font-normal text-muted-foreground">({count})</span>
            ) : null}
          </CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {actions}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}
