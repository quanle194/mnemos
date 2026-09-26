import { AlertTriangle, Inbox, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { ApiError, errorMessage } from '@/api/client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export function LoadingState({ rows = 3, label = 'Loading…' }: { rows?: number; label?: string }) {
  return (
    <div className="flex flex-col gap-2" role="status" aria-live="polite" data-testid="loading">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  )
}

export function ErrorState({
  error,
  onRetry,
  title,
}: {
  error: unknown
  onRetry?: () => void
  title?: string
}) {
  const notFound = error instanceof ApiError && error.status === 404
  const forbidden = error instanceof ApiError && error.status === 403
  const heading = title ?? (notFound ? 'Not found' : forbidden ? 'Not permitted' : 'Something went wrong')
  return (
    <Alert variant="destructive" data-testid="error-state">
      <AlertTriangle />
      <AlertTitle>{heading}</AlertTitle>
      <AlertDescription>
        <p>{errorMessage(error)}</p>
        {error instanceof ApiError && error.requestId ? (
          <p className="font-mono text-xs opacity-80">request_id: {error.requestId}</p>
        ) : null}
        {onRetry && !notFound && !forbidden ? (
          <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
            <RefreshCw /> Retry
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}

export function EmptyState({
  title,
  children,
  icon,
}: {
  title: string
  children?: ReactNode
  icon?: ReactNode
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-10 text-center"
      data-testid="empty-state"
    >
      <div className="text-muted-foreground">{icon ?? <Inbox className="size-6" aria-hidden />}</div>
      <p className="font-medium">{title}</p>
      {children ? <div className="max-w-md text-sm text-muted-foreground">{children}</div> : null}
    </div>
  )
}
