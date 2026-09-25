import { ArrowLeft, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { isDreamActive, useDream } from '@/api/hooks/dreams'
import { IdText } from '@/components/common/IdText'
import { JsonView } from '@/components/common/JsonView'
import { KeyValueGrid } from '@/components/common/KeyValue'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime, formatMetric, humanize } from './dream-format'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function MemoryRef({ id }: { id: string }) {
  return (
    <Link to={`/memories/${id}`} className="font-mono text-xs text-primary hover:underline" title={id}>
      {id.slice(0, 8)}
    </Link>
  )
}

function ValueView({ k, v }: { k: string; v: unknown }): ReactNode {
  if (typeof v === 'string' && UUID_RE.test(v)) {
    if (k === 'conflict') {
      return (
        <Link to={`/conflicts/${v}`} className="font-mono text-xs text-primary hover:underline">
          {v.slice(0, 8)}
        </Link>
      )
    }
    return <MemoryRef id={v} />
  }
  if (Array.isArray(v) && v.every((x) => typeof x === 'string' && UUID_RE.test(x))) {
    return (
      <span className="inline-flex flex-wrap gap-1.5">
        {(v as string[]).map((id) => (
          <MemoryRef key={id} id={id} />
        ))}
      </span>
    )
  }
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return <span>{String(v)}</span>
  return <code className="text-xs">{JSON.stringify(v)}</code>
}

/** Proposal/applied entries are memory ids or objects like {canonical, duplicates} / {members, title, consolidated}. */
function EntryList({ entries, testId, conflictIds }: { entries: unknown[]; testId: string; conflictIds?: boolean }) {
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">None</p>
  return (
    <ul className="flex flex-col divide-y rounded-md border" data-testid={testId}>
      {entries.map((entry, i) => (
        <li key={i} className="flex flex-col gap-1 px-3 py-2 text-sm" data-testid={`${testId}-item`}>
          {typeof entry === 'string' && UUID_RE.test(entry) ? (
            conflictIds ? (
              <ValueView k="conflict" v={entry} />
            ) : (
              <MemoryRef id={entry} />
            )
          ) : entry && typeof entry === 'object' && !Array.isArray(entry) ? (
            <dl className="grid gap-1 sm:grid-cols-[8rem_1fr]">
              {Object.entries(entry as Record<string, unknown>).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-xs text-muted-foreground">{humanize(k)}</dt>
                  <dd>
                    <ValueView k={k} v={v} />
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <code className="text-xs">{JSON.stringify(entry)}</code>
          )}
        </li>
      ))}
    </ul>
  )
}

const KNOWN = new Set(['stats', 'proposals', 'applied', 'opened', 'duration_ms'])

export function DreamDetailPage() {
  const { id = '' } = useParams()
  const q = useDream(id)
  if (q.isPending) return <LoadingState rows={5} />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />
  const d = q.data
  const active = isDreamActive(d)
  const r = d.result_json
  const stats = (r.stats && typeof r.stats === 'object' ? r.stats : {}) as Record<string, unknown>
  const proposals = Array.isArray(r.proposals) ? r.proposals : []
  const applied = Array.isArray(r.applied) ? r.applied : []
  const opened = Array.isArray(r.opened) ? r.opened : []
  const extra = Object.fromEntries(Object.entries(r).filter(([k]) => !KNOWN.has(k)))

  return (
    <div className="flex flex-col gap-5" data-testid="dream-detail" data-id={d.id}>
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/dreams">
            <ArrowLeft /> Dreams
          </Link>
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight capitalize sm:text-2xl">{d.mode} dream</h1>
        <StatusBadge kind="dream" value={d.status} data-testid="dream-status" />
        <Badge variant="outline">{d.trigger_type}</Badge>
        {active ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="dream-polling">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> refreshing every 2s
          </span>
        ) : null}
      </div>

      {d.error ? (
        <Alert variant="destructive" data-testid="dream-error">
          <AlertTitle>Dream failed</AlertTitle>
          <AlertDescription className="font-mono text-xs break-all">{d.error}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent>
          <KeyValueGrid
            items={[
              { label: 'Job', value: <IdText id={d.id} /> },
              { label: 'Created', value: formatDateTime(d.created_at) },
              { label: 'Started', value: formatDateTime(d.started_at) },
              { label: 'Completed', value: formatDateTime(d.completed_at) },
              {
                label: 'Duration',
                value: typeof r.duration_ms === 'number' ? `${formatMetric(r.duration_ms)} ms` : '—',
              },
              { label: 'Window hash', value: d.window_hash ? <IdText id={d.window_hash} /> : '—' },
            ]}
          />
        </CardContent>
      </Card>

      <Card data-testid="dream-stats">
        <CardHeader className="flex-col">
          <CardTitle className="text-base">Result stats</CardTitle>
          <CardDescription>Counts reported by the dream run.</CardDescription>
        </CardHeader>
        <CardContent>
          {Object.keys(stats).length === 0 ? (
            <EmptyState title={active ? 'Dream in progress…' : 'No stats reported'} />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {Object.entries(stats).map(([k, v]) => (
                <div key={k} className="rounded-lg border p-3" data-testid={`dream-stat-${k}`}>
                  <div className="text-xs text-muted-foreground">{humanize(k)}</div>
                  <div className="text-xl font-semibold">{formatMetric(v)}</div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-col">
            <CardTitle className="text-base">Proposals ({proposals.length})</CardTitle>
            <CardDescription>Auditable proposals awaiting validation/review.</CardDescription>
          </CardHeader>
          <CardContent>
            <EntryList entries={proposals} testId="dream-proposals" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-col">
            <CardTitle className="text-base">Applied ({applied.length})</CardTitle>
            <CardDescription>Changes applied under policy (versions/relations recorded).</CardDescription>
          </CardHeader>
          <CardContent>
            <EntryList entries={applied} testId="dream-applied" />
          </CardContent>
        </Card>
        {opened.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Conflicts opened ({opened.length})</CardTitle>
            </CardHeader>
            <CardContent>
              <EntryList entries={opened} testId="dream-opened" conflictIds />
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Input window</CardTitle>
          </CardHeader>
          <CardContent>
            <JsonView value={d.input_window_json} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Checkpoint</CardTitle>
          </CardHeader>
          <CardContent>
            <JsonView value={d.checkpoint_json} />
          </CardContent>
        </Card>
        {Object.keys(extra).length > 0 ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">Other result fields</CardTitle>
            </CardHeader>
            <CardContent>
              <JsonView value={extra} />
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}
