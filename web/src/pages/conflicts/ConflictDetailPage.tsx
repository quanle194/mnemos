import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useConflict, useResolveConflict } from '@/api/hooks/conflicts'
import { CONFLICT_RESOLUTIONS, type ConflictResolution, type Memory } from '@/api/types'
import { usePermissions } from '@/auth/permissions'
import { IdText } from '@/components/common/IdText'
import { JsonView } from '@/components/common/JsonView'
import { ScoreBar } from '@/components/common/ScoreBar'
import { ErrorState, LoadingState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { TimeAgo } from '@/components/common/TimeAgo'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { formatScore, humanize } from '@/lib/format'

const RESOLUTION_HELP: Record<ConflictResolution, string> = {
  keep_existing: 'Keep the existing memory; reject/archive the candidate.',
  accept_candidate: 'Activate the candidate; the existing memory is superseded.',
  keep_both: 'Both are valid (e.g. different contexts); link them as related.',
  archive_both: 'Neither is trustworthy; archive both.',
}

function MemoryPanel({ label, memory, testId }: { label: string; memory: Memory | null; testId: string }) {
  return (
    <Card data-testid={testId} className="h-full">
      <CardHeader>
        <div className="min-w-0">
          <CardDescription className="mt-0 mb-1 text-xs tracking-wide uppercase">{label}</CardDescription>
          {memory ? (
            <CardTitle className="text-base break-words">
              <Link to={`/memories/${memory.id}`} className="hover:text-primary hover:underline">
                {memory.title}
              </Link>
            </CardTitle>
          ) : (
            <CardTitle className="text-base text-muted-foreground">Not visible</CardTitle>
          )}
        </div>
      </CardHeader>
      {memory ? (
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge kind="memory" value={memory.status} data-testid={`${testId}-status`} />
            <Badge variant="outline" className="capitalize">
              {memory.type}
            </Badge>
            <Badge variant="outline">L{memory.layer}</Badge>
            <Badge variant="outline">v{memory.version}</Badge>
            <span className="text-xs text-muted-foreground capitalize">{memory.scope_type} scope</span>
          </div>
          <p className="text-sm whitespace-pre-wrap" data-testid={`${testId}-content`}>
            {memory.content}
          </p>
          <div className="flex flex-col gap-1.5">
            <ScoreBar label="Confidence" value={memory.confidence} />
            <ScoreBar label="Source trust" value={memory.trust_score} />
            <ScoreBar label="Importance" value={memory.importance} />
            <ScoreBar label="Utility" value={memory.utility_score} />
          </div>
          <p className="text-xs text-muted-foreground">
            Created <TimeAgo iso={memory.created_at} /> by {memory.created_by_type}
          </p>
        </CardContent>
      ) : null}
    </Card>
  )
}

export function ConflictDetailPage() {
  const { id = '' } = useParams()
  const q = useConflict(id)
  const resolve = useResolveConflict(id)
  const { can } = usePermissions()
  const [note, setNote] = useState('')

  if (q.isPending) return <LoadingState rows={6} />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />
  const c = q.data
  const judgment = c.analysis_json.judgment as Record<string, unknown> | undefined

  return (
    <div className="flex flex-col gap-5" data-testid="conflict-detail" data-id={c.id}>
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/conflicts">
            <ArrowLeft /> Conflicts
          </Link>
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Conflict {c.id.slice(0, 8)}</h1>
        <StatusBadge kind="conflict" value={c.status} data-testid="conflict-status" />
        <Badge variant="outline">{humanize(c.conflict_type)}</Badge>
        {typeof c.analysis_json.similarity === 'number' ? (
          <span className="text-sm text-muted-foreground">
            similarity {formatScore(c.analysis_json.similarity)}
          </span>
        ) : null}
        <span className="text-sm text-muted-foreground">
          opened <TimeAgo iso={c.created_at} />
        </span>
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <MemoryPanel label="Candidate" memory={c.candidate} testId="conflict-candidate" />
        <MemoryPanel label="Existing" memory={c.existing} testId="conflict-existing" />
      </div>

      {judgment && (typeof judgment.relation === 'string' || typeof judgment.rationale === 'string') ? (
        <Alert data-testid="conflict-judgment">
          <AlertDescription>
            <p>
              <span className="font-medium">Judgment:</span> {String(judgment.relation ?? '—')}
              {typeof judgment.confidence === 'number'
                ? ` (confidence ${formatScore(judgment.confidence)})`
                : ''}
            </p>
            {typeof judgment.rationale === 'string' ? (
              <p className="text-muted-foreground">{judgment.rationale}</p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {c.status === 'open' ? (
        can('memory:review') ? (
          <Card data-testid="conflict-resolve">
            <CardHeader className="flex-col">
              <CardTitle className="text-base">Resolve</CardTitle>
              <CardDescription>
                Resolution is transactional and audited; both memories keep their history.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="conflict-note">Note</Label>
                <Textarea
                  id="conflict-note"
                  rows={2}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  data-testid="conflict-note"
                />
              </div>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                {CONFLICT_RESOLUTIONS.map((r) => (
                  <Button
                    key={r}
                    variant={r === 'archive_both' ? 'outline' : 'secondary'}
                    className="h-auto flex-col items-start gap-0.5 py-2 text-left whitespace-normal"
                    disabled={resolve.isPending}
                    onClick={() =>
                      resolve.mutate(
                        { resolution: r, note: note.trim() },
                        {
                          onSuccess: () => toast.success(`Conflict resolved: ${humanize(r)}`),
                          onError: (err) => toast.error(errorMessage(err)),
                        },
                      )
                    }
                    data-testid={`conflict-resolve-${r}`}
                  >
                    <span className="font-medium">{humanize(r)}</span>
                    <span className="text-xs font-normal text-muted-foreground">{RESOLUTION_HELP[r]}</span>
                  </Button>
                ))}
              </div>
              {resolve.isError ? (
                <Alert variant="destructive">
                  <AlertDescription>{errorMessage(resolve.error)}</AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground">
            Resolving conflicts requires the memory:review permission.
          </p>
        )
      ) : (
        <Card data-testid="conflict-resolution">
          <CardHeader>
            <CardTitle className="text-base">Resolution</CardTitle>
            <span className="text-sm text-muted-foreground">
              resolved <TimeAgo iso={c.resolved_at} />
            </span>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="text-sm">
              <span className="font-medium">
                {typeof c.resolution_json.resolution === 'string'
                  ? humanize(c.resolution_json.resolution)
                  : '—'}
              </span>
              {c.resolution_json.auto === true ? (
                <Badge variant="muted" className="ml-2">
                  automatic
                </Badge>
              ) : null}
              {typeof c.resolution_json.by === 'string' ? (
                <span className="text-muted-foreground"> by {c.resolution_json.by}</span>
              ) : null}
            </p>
            {typeof c.resolution_json.note === 'string' && c.resolution_json.note ? (
              <p className="text-sm text-muted-foreground">{c.resolution_json.note}</p>
            ) : null}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-col">
          <CardTitle className="text-base">Analysis</CardTitle>
          <CardDescription>
            Detector output (similarity, rule signals, LLM judgment). Candidate{' '}
            <IdText id={c.candidate_memory_id} /> vs existing <IdText id={c.existing_memory_id} />.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <JsonView value={c.analysis_json} data-testid="conflict-analysis" />
        </CardContent>
      </Card>
    </div>
  )
}
