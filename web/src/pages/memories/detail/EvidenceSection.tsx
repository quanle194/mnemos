import { Link } from 'react-router'
import { useMemoryEvidence } from '@/api/hooks/memories'
import type { Evidence } from '@/api/types'
import { IdText } from '@/components/common/IdText'
import { JsonView } from '@/components/common/JsonView'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { TimeAgo } from '@/components/common/TimeAgo'
import { Badge } from '@/components/ui/badge'
import { humanize, truncate } from '@/lib/format'
import { Section } from './Section'

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : JSON.stringify(v)
}

/** Human-readable summary of the evidence source ("Why does Mnemos believe this?"). */
function SourceSummary({ ev }: { ev: Evidence }) {
  const s = ev.source
  if (ev.source_type === 'experience') {
    return (
      <div className="flex flex-col gap-1 text-sm" data-testid="evidence-source">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/experiences/${ev.source_id}`} className="font-medium text-primary hover:underline">
            Experience <IdText id={ev.source_id} />
          </Link>
          {s?.outcome ? <StatusBadge kind="outcome" value={str(s.outcome)} /> : null}
          {s?.source ? <Badge variant="outline">source: {str(s.source)}</Badge> : null}
        </div>
        {s ? (
          <dl className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-[6rem_1fr]">
            {(['task', 'observation', 'action', 'result'] as const)
              .filter((k) => str(s[k]))
              .map((k) => (
                <div key={k} className="contents">
                  <dt className="font-medium capitalize">{k}</dt>
                  <dd className="text-foreground/90">{truncate(str(s[k]), 280)}</dd>
                </div>
              ))}
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">Source experience is not visible to this key.</p>
        )}
      </div>
    )
  }
  if (ev.source_type === 'memory') {
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="evidence-source">
        <Link to={`/memories/${ev.source_id}`} className="font-medium text-primary hover:underline">
          {s?.title ? str(s.title) : <>Memory <IdText id={ev.source_id} /></>}
        </Link>
        {s?.status ? <StatusBadge kind="memory" value={str(s.status)} /> : null}
        {s?.type ? <Badge variant="outline">{str(s.type)}</Badge> : null}
      </div>
    )
  }
  if (ev.source_type === 'event' && s) {
    return (
      <div className="flex flex-col gap-1 text-sm" data-testid="evidence-source">
        <span>
          Event <IdText id={ev.source_id} /> <Badge variant="outline">{str(s.type)}</Badge>
        </span>
        <JsonView value={s.payload} maxHeight="max-h-40" />
      </div>
    )
  }
  return (
    <div className="text-sm" data-testid="evidence-source">
      <span className="text-muted-foreground">{humanize(ev.source_type)}</span>{' '}
      <span className="font-mono text-xs">{ev.source_id}</span>
    </div>
  )
}

export function EvidenceSection({ memoryId }: { memoryId: string }) {
  const q = useMemoryEvidence(memoryId)
  return (
    <Section
      title="Evidence"
      description="Why Mnemos believes this — provenance links to experiences, events, memories and statements."
      count={q.data?.length}
      testId="memory-evidence"
    >
      {q.isPending ? (
        <LoadingState rows={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="No evidence recorded" />
      ) : (
        <ul className="flex flex-col divide-y">
          {q.data.map((ev) => (
            <li key={ev.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" data-testid="evidence-row" data-id={ev.id}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="info">{humanize(ev.source_type)}</Badge>
                <Badge variant="outline">{ev.relation}</Badge>
                <span className="text-muted-foreground">weight {ev.weight}</span>
                <span className="ml-auto text-muted-foreground">
                  <TimeAgo iso={ev.created_at} />
                </span>
              </div>
              <SourceSummary ev={ev} />
              {ev.excerpt ? (
                <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground italic" data-testid="evidence-excerpt">
                  {truncate(ev.excerpt, 500)}
                </blockquote>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
