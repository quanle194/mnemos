import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { useMemory } from '@/api/hooks/memories'
import { usePermissions } from '@/auth/permissions'
import { IdText } from '@/components/common/IdText'
import { JsonView } from '@/components/common/JsonView'
import { KeyValueGrid } from '@/components/common/KeyValue'
import { ScoreBar } from '@/components/common/ScoreBar'
import { ErrorState, LoadingState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime, humanize } from '@/lib/format'
import { EvidenceSection } from './detail/EvidenceSection'
import { FeedbackSection } from './detail/FeedbackSection'
import { HistorySection } from './detail/HistorySection'
import { MemoryActions } from './detail/MemoryActions'
import { RelationsSection } from './detail/RelationsSection'
import { UsageSection } from './detail/UsageSection'

export function MemoryDetailPage() {
  const { id = '' } = useParams()
  const q = useMemory(id)
  const { can, me } = usePermissions()

  if (q.isPending) return <LoadingState rows={6} />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />

  const m = q.data
  const canReview = can('memory:review')
  const canModify =
    canReview || (can('memory:propose') && m.status === 'candidate' && m.created_by_id === me?.actor_id)
  const expired = m.valid_until !== null && new Date(m.valid_until).getTime() < Date.now()

  return (
    <div className="flex flex-col gap-5" data-testid="memory-detail" data-id={m.id}>
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/memories">
            <ArrowLeft /> Memories
          </Link>
        </Button>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1
            className="text-xl font-semibold tracking-tight break-words sm:text-2xl"
            data-testid="memory-title"
          >
            {m.title}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge kind="memory" value={m.status} data-testid="memory-status-badge" />
            <Badge variant="outline" className="capitalize" data-testid="memory-type">
              {m.type}
            </Badge>
            <Badge variant="outline" data-testid="memory-layer">
              L{m.layer}
            </Badge>
            {m.review_state !== 'none' ? (
              <StatusBadge kind="review" value={m.review_state} data-testid="memory-review-state" />
            ) : null}
            {expired ? <Badge variant="warning">Expired</Badge> : null}
            <span className="text-xs text-muted-foreground">
              <IdText id={m.id} />
            </span>
          </div>
        </div>
        <MemoryActions memory={m} caps={{ canModify, canReview }} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2" data-testid="memory-content-card">
          <CardHeader>
            <CardTitle className="text-base">Content</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm leading-relaxed whitespace-pre-wrap" data-testid="memory-content">
              {m.content}
            </p>
            {Object.keys(m.metadata_json).length > 0 ? (
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground">Metadata</summary>
                <JsonView value={m.metadata_json} className="mt-2" data-testid="memory-metadata" />
              </details>
            ) : null}
          </CardContent>
        </Card>
        <Card data-testid="memory-trust">
          <CardHeader>
            <CardTitle className="text-base">Trust signals</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <ScoreBar label="Confidence" value={m.confidence} />
            <ScoreBar label="Source trust" value={m.trust_score} />
            <ScoreBar label="Importance" value={m.importance} />
            <ScoreBar label="Utility" value={m.utility_score} />
            <p className="mt-1 text-xs text-muted-foreground">
              Kept separate by design — ranking combines them with configurable weights.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card data-testid="memory-properties">
        <CardHeader>
          <CardTitle className="text-base">Properties</CardTitle>
        </CardHeader>
        <CardContent>
          <KeyValueGrid
            items={[
              { label: 'Type', value: humanize(m.type), testId: 'memory-prop-type' },
              { label: 'Status', value: humanize(m.status), testId: 'memory-prop-status' },
              {
                label: 'Scope',
                value: (
                  <span>
                    {humanize(m.scope_type)} <IdText id={m.scope_id} className="text-muted-foreground" />
                  </span>
                ),
                testId: 'memory-prop-scope',
              },
              { label: 'Layer', value: `L${m.layer}`, testId: 'memory-prop-layer' },
              { label: 'Version', value: m.version, testId: 'memory-version' },
              { label: 'Review state', value: humanize(m.review_state) },
              { label: 'Valid from', value: formatDateTime(m.valid_from), testId: 'memory-prop-valid-from' },
              {
                label: 'Valid until',
                value: m.valid_until ? formatDateTime(m.valid_until) : 'No expiry',
                testId: 'memory-prop-valid-until',
              },
              { label: 'Retrieved', value: `${m.retrieval_count}×`, testId: 'memory-prop-retrieval-count' },
              { label: 'Last retrieved', value: formatDateTime(m.last_retrieved_at) },
              {
                label: 'Created by',
                value: (
                  <span className="break-all">
                    {m.created_by_type}
                    {m.created_by_id ? `:${m.created_by_id}` : ''}
                  </span>
                ),
              },
              { label: 'Created', value: formatDateTime(m.created_at) },
              { label: 'Updated', value: formatDateTime(m.updated_at) },
              { label: 'Project', value: <IdText id={m.project_id} /> },
              { label: 'Agent', value: <IdText id={m.agent_id} /> },
              {
                label: 'Workspace',
                value: m.workspace_id ? <IdText id={m.workspace_id} /> : 'Organization-wide',
              },
            ]}
          />
        </CardContent>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <EvidenceSection memoryId={m.id} />
        <HistorySection memoryId={m.id} currentVersion={m.version} />
        <RelationsSection memoryId={m.id} />
        <FeedbackSection memoryId={m.id} canWrite={can('feedback:write')} />
      </div>
      <UsageSection memoryId={m.id} retrievalCount={m.retrieval_count} />
    </div>
  )
}
