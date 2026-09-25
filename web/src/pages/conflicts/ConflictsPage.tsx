import { Link, useSearchParams } from 'react-router'
import { useConflictList } from '@/api/hooks/conflicts'
import type { ConflictStatus } from '@/api/types'
import { useWorkspaceId } from '@/auth/session-context'
import { IdText } from '@/components/common/IdText'
import { LoadMore } from '@/components/common/LoadMore'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { TimeAgo } from '@/components/common/TimeAgo'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatScore, humanize } from '@/lib/format'

type Filter = ConflictStatus | 'all'

export function ConflictsPage() {
  const ws = useWorkspaceId()
  const [params, setParams] = useSearchParams()
  const raw = params.get('status')
  const filter: Filter = raw === 'resolved' || raw === 'all' ? raw : 'open'
  const list = useConflictList(ws, filter === 'all' ? undefined : filter)

  return (
    <>
      <PageHeader
        title="Conflicts"
        description="Contradictions between candidate and existing knowledge — never silently overwritten."
      />
      <Tabs value={filter} onValueChange={(v) => setParams(v === 'open' ? {} : { status: v }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="open" data-testid="conflicts-tab-open">
            Open
          </TabsTrigger>
          <TabsTrigger value="resolved" data-testid="conflicts-tab-resolved">
            Resolved
          </TabsTrigger>
          <TabsTrigger value="all" data-testid="conflicts-tab-all">
            All
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <Card>
        <CardContent>
          {list.isPending ? (
            <LoadingState rows={4} />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : list.items.length === 0 ? (
            <EmptyState title={filter === 'open' ? 'No open conflicts' : 'No conflicts'}>
              Conflicts are opened by validation or contradiction dreams.
            </EmptyState>
          ) : (
            <>
              <Table data-testid="conflict-list">
                <TableHeader>
                  <TableRow>
                    <TableHead>Conflict</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Candidate</TableHead>
                    <TableHead>Existing</TableHead>
                    <TableHead className="text-right">Similarity</TableHead>
                    <TableHead>Resolution</TableHead>
                    <TableHead>Opened</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.items.map((c) => {
                    const sim = c.analysis_json.similarity
                    const resolution = c.resolution_json.resolution
                    return (
                      <TableRow key={c.id} data-testid="conflict-row" data-id={c.id} data-status={c.status}>
                        <TableCell>
                          <Link
                            to={`/conflicts/${c.id}`}
                            className="font-medium text-primary hover:underline"
                            data-testid="conflict-row-link"
                          >
                            <IdText id={c.id} />
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{humanize(c.conflict_type)}</Badge>
                        </TableCell>
                        <TableCell>
                          <StatusBadge kind="conflict" value={c.status} />
                        </TableCell>
                        <TableCell>
                          <Link to={`/memories/${c.candidate_memory_id}`} className="hover:underline">
                            <IdText id={c.candidate_memory_id} />
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Link to={`/memories/${c.existing_memory_id}`} className="hover:underline">
                            <IdText id={c.existing_memory_id} />
                          </Link>
                        </TableCell>
                        <TableCell className="tabular text-right">
                          {typeof sim === 'number' ? formatScore(sim) : '—'}
                        </TableCell>
                        <TableCell>{typeof resolution === 'string' ? humanize(resolution) : '—'}</TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          <TimeAgo iso={c.created_at} />
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
              <LoadMore query={list} data-testid="conflict-load-more" />
            </>
          )}
        </CardContent>
      </Card>
    </>
  )
}
