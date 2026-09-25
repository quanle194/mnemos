import { useMemoryHistory } from '@/api/hooks/memories'
import { JsonView } from '@/components/common/JsonView'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { TimeAgo } from '@/components/common/TimeAgo'
import { Badge } from '@/components/ui/badge'
import { diffSnapshots, displayValue } from '@/lib/diff'
import { Section } from './Section'

export function HistorySection({ memoryId, currentVersion }: { memoryId: string; currentVersion: number }) {
  const q = useMemoryHistory(memoryId)
  return (
    <Section
      title="History"
      description="Every change creates a new version; nothing is silently overwritten."
      count={q.data?.length}
      testId="memory-history"
    >
      {q.isPending ? (
        <LoadingState rows={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="No versions recorded" />
      ) : (
        <ol className="relative flex flex-col gap-4 border-l pl-5">
          {[...q.data]
            .sort((a, b) => b.version - a.version)
            .map((v) => {
              const prev = q.data.find((p) => p.version === v.version - 1)
              const changes = diffSnapshots(prev?.snapshot_json ?? null, v.snapshot_json)
              return (
                <li key={v.id} className="relative" data-testid="history-row" data-version={v.version}>
                  <span
                    aria-hidden
                    className="absolute top-1.5 -left-[1.6rem] size-2.5 rounded-full border-2 border-background bg-chart-1"
                  />
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant={v.version === currentVersion ? 'default' : 'outline'}>v{v.version}</Badge>
                    <span className="font-medium" data-testid="history-reason">
                      {v.change_reason || '—'}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    by <span data-testid="history-actor">{v.actor_type}:{v.actor_id ?? '—'}</span> ·{' '}
                    <TimeAgo iso={v.created_at} />
                  </div>
                  {prev ? (
                    changes.length > 0 ? (
                      <ul className="mt-2 flex flex-col gap-1 text-xs" data-testid="history-diff">
                        {changes.map((c) => (
                          <li key={c.key} className="grid gap-1 sm:grid-cols-[8rem_1fr]">
                            <span className="font-mono text-muted-foreground">{c.key}</span>
                            <span className="break-words">
                              <del className="text-destructive/80 decoration-destructive/60">{displayValue(c.before)}</del>
                              <span className="mx-1 text-muted-foreground" aria-label="changed to">
                                →
                              </span>
                              <ins className="text-success no-underline">{displayValue(c.after)}</ins>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-xs text-muted-foreground">No field changes in snapshot.</p>
                    )
                  ) : (
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer text-muted-foreground">Initial snapshot</summary>
                      <JsonView value={v.snapshot_json} className="mt-1" maxHeight="max-h-60" />
                    </details>
                  )}
                </li>
              )
            })}
        </ol>
      )}
    </Section>
  )
}
