import { ChevronDown, ChevronRight } from 'lucide-react'
import { Fragment, useState } from 'react'
import { useEvalRuns } from '@/api/hooks/ops'
import type { EvalRun } from '@/api/types'
import { useWorkspaceId } from '@/auth/session-context'
import { JsonView } from '@/components/common/JsonView'
import { LoadMore } from '@/components/common/LoadMore'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { TimeAgo } from '@/components/common/TimeAgo'
import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { humanize } from '@/lib/format'
import { classifyMetrics, formatMetricValue, type Metric, type MetricKind } from '@/lib/metrics'

const KIND_BADGE: Record<MetricKind, { variant: BadgeVariant; label: string }> = {
  measured: { variant: 'success', label: 'measured' },
  estimated: { variant: 'warning', label: 'estimated' },
  unlabelled: { variant: 'muted', label: 'unlabelled' },
}

function MetricsTable({ metrics }: { metrics: Metric[] }) {
  if (metrics.length === 0) return <p className="text-sm text-muted-foreground">No summary metrics.</p>
  return (
    <Table data-testid="eval-metrics">
      <TableHeader>
        <TableRow>
          <TableHead>Metric</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead>Basis</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {metrics.map((m) => (
          <TableRow key={m.key} data-testid="eval-metric" data-kind={m.kind}>
            <TableCell className="font-mono text-xs">{m.key}</TableCell>
            <TableCell className="tabular text-right font-medium">{formatMetricValue(m.value)}</TableCell>
            <TableCell>
              <Badge variant={KIND_BADGE[m.kind].variant}>{KIND_BADGE[m.kind].label}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function headline(run: EvalRun): string {
  const metrics = classifyMetrics(run.summary_json)
  return metrics
    .filter((m) => typeof m.value === 'number')
    .slice(0, 3)
    .map((m) => `${humanize(m.key.split('.').pop() ?? m.key)}: ${formatMetricValue(m.value)}${m.kind === 'estimated' ? ' (est.)' : ''}`)
    .join(' · ')
}

export function EvalsPage() {
  const ws = useWorkspaceId()
  const [onlyWorkspace, setOnlyWorkspace] = useState(false)
  const list = useEvalRuns(onlyWorkspace ? ws : null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <>
      <PageHeader
        title="Evals"
        description="Benchmark runs comparing memory-enabled agents against baselines. Estimates are labelled — never presented as measurements."
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <label className="flex items-center gap-2 text-sm" htmlFor="evals-only-workspace">
            <Checkbox
              id="evals-only-workspace"
              checked={onlyWorkspace}
              onChange={(e) => setOnlyWorkspace(e.target.checked)}
            />
            Only runs attached to the active workspace
          </label>
          {list.isPending ? (
            <LoadingState rows={4} />
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : list.items.length === 0 ? (
            <EmptyState title="No eval runs recorded">
              Run <code className="font-mono">make eval</code> to execute the benchmark and store results.
            </EmptyState>
          ) : (
            <>
              <Table data-testid="eval-list">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <span className="sr-only">Expand</span>
                    </TableHead>
                    <TableHead>Run</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Headline</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.items.map((run) => {
                    const expanded = open.has(run.id)
                    return (
                      <Fragment key={run.id}>
                        <TableRow data-testid="eval-row" data-id={run.id}>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              aria-expanded={expanded}
                              aria-label={expanded ? `Collapse ${run.name}` : `Expand ${run.name}`}
                              onClick={() => toggle(run.id)}
                              data-testid="eval-row-toggle"
                            >
                              {expanded ? <ChevronDown /> : <ChevronRight />}
                            </Button>
                          </TableCell>
                          <TableCell className="font-medium">{run.name}</TableCell>
                          <TableCell>
                            <Badge variant={run.status === 'completed' || run.status === 'succeeded' ? 'success' : 'outline'}>
                              {run.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="max-w-96 text-xs text-muted-foreground">{headline(run) || '—'}</TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            <TimeAgo iso={run.created_at} />
                          </TableCell>
                        </TableRow>
                        {expanded ? (
                          <TableRow data-testid="eval-row-details">
                            <TableCell colSpan={5} className="bg-muted/20">
                              <div className="grid gap-4 py-2 lg:grid-cols-2">
                                <div>
                                  <h3 className="mb-2 text-sm font-medium">Summary metrics</h3>
                                  <MetricsTable metrics={classifyMetrics(run.summary_json)} />
                                </div>
                                <div>
                                  <h3 className="mb-2 text-sm font-medium">Full result</h3>
                                  <JsonView value={run.result_json} maxHeight="max-h-96" data-testid="eval-result-json" />
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
              <LoadMore query={list} data-testid="eval-load-more" />
            </>
          )}
        </CardContent>
      </Card>
    </>
  )
}
