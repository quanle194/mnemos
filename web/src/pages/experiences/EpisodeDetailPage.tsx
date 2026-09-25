import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { useEpisode } from '@/api/hooks/experiences'
import { KeyValueGrid } from '@/components/common/KeyValue'
import { IdText } from '@/components/common/IdText'
import { ErrorState, LoadingState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { TimeAgo } from '@/components/common/TimeAgo'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateTime, formatScore, truncate } from '@/lib/format'

export function EpisodeDetailPage() {
  const { id = '' } = useParams()
  const q = useEpisode(id)
  if (q.isPending) return <LoadingState rows={5} />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />
  const ep = q.data
  return (
    <div className="flex flex-col gap-5" data-testid="episode-detail" data-id={ep.id}>
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/experiences?tab=episodes">
            <ArrowLeft /> Episodes
          </Link>
        </Button>
      </div>
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Episode</h1>
        <p className="mt-1 text-sm whitespace-pre-wrap text-muted-foreground">
          {ep.summary || '(no summary)'}
        </p>
      </div>
      <Card>
        <CardContent>
          <KeyValueGrid
            items={[
              { label: 'Outcome', value: <StatusBadge kind="outcome" value={ep.outcome} /> },
              { label: 'Experiences', value: ep.experience_count },
              { label: 'Importance', value: formatScore(ep.importance) },
              { label: 'Confidence', value: formatScore(ep.confidence) },
              { label: 'Task id', value: ep.task_id ?? '—' },
              { label: 'Agent', value: <IdText id={ep.agent_id} /> },
              { label: 'Started', value: formatDateTime(ep.started_at) },
              { label: 'Completed', value: formatDateTime(ep.completed_at) },
            ]}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Experiences in this episode</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Learning</TableHead>
                <TableHead>Recorded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ep.experiences.map((e) => (
                <TableRow key={e.id} data-testid="episode-experience-row">
                  <TableCell>
                    <Link
                      to={`/experiences/${e.id}`}
                      className="font-medium hover:text-primary hover:underline"
                    >
                      {truncate(e.task, 120)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge kind="outcome" value={e.outcome} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge kind="processing" value={e.processing_status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <TimeAgo iso={e.created_at} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
