import { Link } from 'react-router'
import { useMemoryUsage } from '@/api/hooks/memories'
import { IdText } from '@/components/common/IdText'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { TimeAgo } from '@/components/common/TimeAgo'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatScore, truncate } from '@/lib/format'
import { Section } from './Section'

export function UsageSection({ memoryId, retrievalCount }: { memoryId: string; retrievalCount: number }) {
  const q = useMemoryUsage(memoryId)
  return (
    <Section
      title="Retrieval usage"
      description={`Selected into context/search results ${retrievalCount} time(s). Latest 50 shown.`}
      count={q.data?.length}
      testId="memory-usage"
    >
      {q.isPending ? (
        <LoadingState rows={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.length === 0 ? (
        <EmptyState title="Not retrieved yet" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Query</TableHead>
              <TableHead className="text-right">Rank</TableHead>
              <TableHead className="text-right">Score</TableHead>
              <TableHead>Agent</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.data.map((u) => (
              <TableRow key={`${u.trace_id}-${u.rank}`} data-testid="usage-row">
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  <Link to={`/traces/${u.trace_id}`} className="hover:underline">
                    <TimeAgo iso={u.created_at} />
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{u.kind}</Badge>
                </TableCell>
                <TableCell className="max-w-72 truncate" title={u.query}>
                  {truncate(u.query, 80)}
                </TableCell>
                <TableCell className="tabular text-right">{u.rank}</TableCell>
                <TableCell className="tabular text-right">{formatScore(u.score, 3)}</TableCell>
                <TableCell>
                  <IdText id={u.agent_id} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  )
}
