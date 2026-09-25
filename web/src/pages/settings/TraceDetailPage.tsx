import { ArrowLeft } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { useTrace } from '@/api/hooks/ops'
import { IdText } from '@/components/common/IdText'
import { JsonView } from '@/components/common/JsonView'
import { KeyValueGrid } from '@/components/common/KeyValue'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateTime, formatNumber, formatScore } from '@/lib/format'

interface SelectedItem {
  id: string
  rank?: number
  score?: number
  reasons?: string[]
}

interface CandidateItem {
  id: string
  status?: string
  scores?: Record<string, number>
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : []
}

export function TraceDetailPage() {
  const { id = '' } = useParams()
  const q = useTrace(id)
  if (q.isPending) return <LoadingState rows={5} />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />
  const t = q.data
  const selected = asArray<SelectedItem>(t.selected_json.items)
  const candidates = asArray<CandidateItem>(t.candidates_json.items)
  const excluded = asArray<unknown>(t.candidates_json.excluded)
  const scoreKeys = Array.from(new Set(candidates.flatMap((c) => Object.keys(c.scores ?? {})))).filter((k) => k !== 'total')
  const candidateMeta = Object.fromEntries(
    Object.entries(t.candidates_json).filter(([k]) => k !== 'items' && k !== 'excluded'),
  )

  return (
    <div className="flex flex-col gap-5" data-testid="trace-detail" data-id={t.id}>
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/settings?tab=traces">
            <ArrowLeft /> Retrieval traces
          </Link>
        </Button>
      </div>
      <div>
        <h1 className="text-xl font-semibold tracking-tight break-words sm:text-2xl">“{t.query}”</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge variant="outline">{t.kind}</Badge>
          <IdText id={t.id} className="text-muted-foreground" />
        </div>
      </div>
      <Card>
        <CardContent>
          <KeyValueGrid
            items={[
              { label: 'Selected', value: selected.length },
              { label: 'Candidates', value: candidates.length },
              { label: 'Context tokens', value: formatNumber(t.context_tokens) },
              { label: 'Latency', value: `${formatNumber(t.latency_ms)} ms` },
              { label: 'Agent', value: <IdText id={t.agent_id} /> },
              { label: 'When', value: formatDateTime(t.created_at) },
            ]}
          />
        </CardContent>
      </Card>

      <Card data-testid="trace-selected">
        <CardHeader className="flex-col">
          <CardTitle className="text-base">Selected memories</CardTitle>
          <CardDescription>Final ranked selection returned to the caller, with reasons.</CardDescription>
        </CardHeader>
        <CardContent>
          {selected.length === 0 ? (
            <EmptyState title="Nothing selected" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">Rank</TableHead>
                  <TableHead>Memory</TableHead>
                  <TableHead className="text-right">Score</TableHead>
                  <TableHead>Reasons</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {selected.map((s) => (
                  <TableRow key={s.id} data-testid="trace-selected-row">
                    <TableCell className="tabular text-right">{s.rank ?? '—'}</TableCell>
                    <TableCell>
                      <Link to={`/memories/${s.id}`} className="font-mono text-xs text-primary hover:underline">
                        {s.id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="tabular text-right">{formatScore(s.score ?? null, 3)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{(s.reasons ?? []).join(' · ')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card data-testid="trace-candidates">
        <CardHeader className="flex-col">
          <CardTitle className="text-base">Candidates ({candidates.length})</CardTitle>
          <CardDescription>Component scores for every candidate considered (top 100).</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {candidates.length === 0 ? (
            <EmptyState title="No candidates recorded" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Memory</TableHead>
                  <TableHead>Status</TableHead>
                  {scoreKeys.map((k) => (
                    <TableHead key={k} className="text-right capitalize">
                      {k.replace('_', ' ')}
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {candidates.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link to={`/memories/${c.id}`} className="font-mono text-xs text-primary hover:underline">
                        {c.id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>{c.status ? <StatusBadge kind="memory" value={c.status} /> : '—'}</TableCell>
                    {scoreKeys.map((k) => (
                      <TableCell key={k} className="tabular text-right">
                        {formatScore(c.scores?.[k] ?? null)}
                      </TableCell>
                    ))}
                    <TableCell className="tabular text-right font-medium">{formatScore(c.scores?.total ?? null, 3)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {excluded.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-sm">Excluded ({excluded.length})</summary>
              <JsonView value={excluded} className="mt-2" />
            </details>
          ) : null}
          {Object.keys(candidateMeta).length > 0 ? (
            <details>
              <summary className="cursor-pointer text-sm">Candidate generation metadata</summary>
              <JsonView value={candidateMeta} className="mt-2" />
            </details>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Request</CardTitle>
        </CardHeader>
        <CardContent>
          <JsonView value={t.request_json} />
        </CardContent>
      </Card>
    </div>
  )
}
