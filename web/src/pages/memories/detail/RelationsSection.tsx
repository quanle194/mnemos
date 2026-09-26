import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Link } from 'react-router'
import { useMemoryRelations } from '@/api/hooks/memories'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { Badge } from '@/components/ui/badge'
import { humanize } from '@/lib/format'
import { Section } from './Section'

export function RelationsSection({ memoryId }: { memoryId: string }) {
  const q = useMemoryRelations(memoryId)
  return (
    <Section
      title="Relations"
      description="Supports, contradicts, supersedes, derived-from and generalization links."
      count={q.data?.length}
      testId="memory-relations"
    >
      {q.isPending ? (
        <LoadingState rows={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="No relations" />
      ) : (
        <ul className="flex flex-col divide-y">
          {q.data.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center gap-2 py-2 text-sm first:pt-0 last:pb-0"
              data-testid="relation-row"
              data-relation={r.relation}
            >
              {r.direction === 'outgoing' ? (
                <ArrowRight className="size-4 text-muted-foreground" aria-label="outgoing" />
              ) : (
                <ArrowLeft className="size-4 text-muted-foreground" aria-label="incoming" />
              )}
              <Badge variant="info">{humanize(r.relation)}</Badge>
              <span className="text-xs text-muted-foreground">
                {r.direction === 'outgoing' ? 'this →' : '← from'}
              </span>
              <Link
                to={`/memories/${r.other.id}`}
                className="min-w-0 flex-1 truncate font-medium text-primary hover:underline"
                data-testid="relation-link"
              >
                {r.other.title}
              </Link>
              <Badge variant="outline" className="capitalize">
                {r.other.type}
              </Badge>
              <StatusBadge kind="memory" value={r.other.status} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}
