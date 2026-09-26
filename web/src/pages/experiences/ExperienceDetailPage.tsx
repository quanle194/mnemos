import { ArrowLeft, Loader2 } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { learningPollInterval, useExperience } from '@/api/hooks/experiences'
import { IdText } from '@/components/common/IdText'
import { JsonView } from '@/components/common/JsonView'
import { KeyValueGrid } from '@/components/common/KeyValue'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime, formatScore } from '@/lib/format'

export function ExperienceDetailPage() {
  const { id = '' } = useParams()
  const q = useExperience(id)
  if (q.isPending) return <LoadingState rows={6} />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />
  const e = q.data
  const learning = e.learning
  const polling = learningPollInterval(e) !== false

  return (
    <div className="flex flex-col gap-5" data-testid="experience-detail" data-id={e.id}>
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/experiences">
            <ArrowLeft /> Experiences
          </Link>
        </Button>
      </div>
      <div>
        <h1 className="text-xl font-semibold tracking-tight break-words sm:text-2xl">{e.task}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StatusBadge kind="outcome" value={e.outcome} data-testid="experience-outcome-badge" />
          <Badge variant="outline">source: {e.source}</Badge>
          <Badge variant="outline">source trust {formatScore(e.source_trust)}</Badge>
          <IdText id={e.id} className="text-muted-foreground" />
        </div>
      </div>

      <Card data-testid="experience-learning">
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              Learning status
              {polling ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="refreshing" />
              ) : null}
            </CardTitle>
            <CardDescription>
              Extraction → validation runs asynchronously in workers.
              {polling ? ' This page refreshes automatically until processing completes.' : null}
            </CardDescription>
          </div>
          <StatusBadge
            kind="processing"
            value={e.processing_status}
            data-testid="experience-processing-status"
          />
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <KeyValueGrid
            items={[
              { label: 'Processing', value: e.processing_status },
              { label: 'Learning job', value: learning?.job_id ? <IdText id={learning.job_id} /> : '—' },
              { label: 'Job status', value: learning?.job_status ?? '—', testId: 'experience-job-status' },
              { label: 'Processed at', value: formatDateTime(e.processed_at) },
            ]}
          />
          <div>
            <h3 className="mb-2 text-sm font-medium">Derived memories</h3>
            {learning && learning.memories.length > 0 ? (
              <ul
                className="flex flex-col divide-y rounded-md border"
                data-testid="experience-derived-memories"
              >
                {learning.memories.map((m) => (
                  <li
                    key={m.id}
                    className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
                    data-testid="experience-derived-memory"
                  >
                    <Link
                      to={`/memories/${m.id}`}
                      className="min-w-0 flex-1 font-medium text-primary hover:underline"
                    >
                      {m.title}
                    </Link>
                    <Badge variant="outline" className="capitalize">
                      {m.type}
                    </Badge>
                    <StatusBadge kind="memory" value={m.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                title={
                  e.processing_status === 'processed' ? 'No durable knowledge extracted' : 'Not processed yet'
                }
              >
                {e.processing_status === 'processed'
                  ? 'The extractor decided this experience holds nothing future-useful (or it merged into existing knowledge).'
                  : 'Candidate memories appear here once a worker processes this experience.'}
              </EmptyState>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Trajectory</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-[8rem_1fr]">
            {(['observation', 'action', 'result'] as const).map((k) => (
              <div key={k} className="contents">
                <dt className="font-medium text-muted-foreground capitalize">{k}</dt>
                <dd className="whitespace-pre-wrap" data-testid={`experience-${k}-value`}>
                  {e[k] || '—'}
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Properties</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <KeyValueGrid
            items={[
              { label: 'Importance', value: formatScore(e.importance) },
              { label: 'Confidence', value: formatScore(e.confidence) },
              { label: 'Task id', value: e.task_id ?? '—' },
              {
                label: 'Episode',
                value: e.episode_id ? (
                  <Link to={`/episodes/${e.episode_id}`} className="text-primary hover:underline">
                    <IdText id={e.episode_id} />
                  </Link>
                ) : (
                  '—'
                ),
              },
              { label: 'Project', value: <IdText id={e.project_id} /> },
              { label: 'Agent', value: <IdText id={e.agent_id} /> },
              { label: 'Session', value: <IdText id={e.session_id} /> },
              { label: 'Recorded', value: formatDateTime(e.created_at) },
            ]}
          />
          {Object.keys(e.metadata_json).length > 0 ? <JsonView value={e.metadata_json} /> : null}
        </CardContent>
      </Card>
    </div>
  )
}
