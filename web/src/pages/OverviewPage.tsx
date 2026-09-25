import { Link } from 'react-router'
import { useAuditLogs, useStats } from '@/api/hooks/ops'
import { useWorkspaces } from '@/api/hooks/tenancy'
import { MEMORY_STATUSES, OUTCOMES, type AuditLog } from '@/api/types'
import { useWorkspaceId } from '@/auth/session-context'
import { BarList } from '@/components/common/BarList'
import { IdText } from '@/components/common/IdText'
import { LoadMore } from '@/components/common/LoadMore'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { TimeAgo } from '@/components/common/TimeAgo'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatCompact, formatNumber, sumValues } from '@/lib/format'

function StatTile({ id, label, value, hint, to }: { id: string; label: string; value: string; hint?: string; to?: string }) {
  const body = (
    <Card className="h-full gap-1 py-4 transition-colors hover:bg-accent/40" data-testid={`stat-${id}`}>
      <CardContent className="flex flex-col gap-1">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-2xl font-semibold tracking-tight" data-testid={`stat-${id}-value`}>
          {value}
        </span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </CardContent>
    </Card>
  )
  return to ? (
    <Link to={to} className="rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
      {body}
    </Link>
  ) : (
    body
  )
}

function DistributionCard({
  title,
  description,
  data,
  testId,
  order,
  formatLabel,
}: {
  title: string
  description?: string
  data: Record<string, number> | undefined
  testId: string
  order?: readonly string[]
  formatLabel?: (k: string) => string
}) {
  return (
    <Card>
      <CardHeader className="flex-col gap-0">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description ? <CardDescription className="mt-1 text-xs">{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        <BarList data={data} data-testid={testId} order={order} formatLabel={formatLabel} />
      </CardContent>
    </Card>
  )
}

function resourceLink(log: AuditLog): string | null {
  if (!log.resource_id) return null
  switch (log.resource_type) {
    case 'memory':
      return `/memories/${log.resource_id}`
    case 'experience':
      return `/experiences/${log.resource_id}`
    case 'dream_job':
      return `/dreams/${log.resource_id}`
    case 'conflict':
      return `/conflicts/${log.resource_id}`
    default:
      return null
  }
}

function AuditCard({ ws }: { ws: string }) {
  const audit = useAuditLogs(ws)
  return (
    <Card>
      <CardHeader className="flex-col gap-0">
        <CardTitle className="text-sm">Recent activity</CardTitle>
        <CardDescription className="mt-1 text-xs">Audit log of state transitions in this workspace</CardDescription>
      </CardHeader>
      <CardContent>
        {audit.isPending ? (
          <LoadingState />
        ) : audit.isError ? (
          <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />
        ) : audit.items.length === 0 ? (
          <EmptyState title="No audit events yet" />
        ) : (
          <>
            <Table data-testid="audit-list">
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Resource</TableHead>
                  <TableHead>Actor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.items.map((log) => {
                  const href = resourceLink(log)
                  return (
                    <TableRow key={log.id} data-testid="audit-row" data-id={log.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        <TimeAgo iso={log.created_at} />
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-mono">
                          {log.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span className="text-muted-foreground">{log.resource_type} </span>
                        {href ? (
                          <Link to={href} className="text-primary hover:underline">
                            <IdText id={log.resource_id} />
                          </Link>
                        ) : (
                          <IdText id={log.resource_id} />
                        )}
                      </TableCell>
                      <TableCell className="max-w-48 truncate text-muted-foreground" title={log.actor_id ?? ''}>
                        {log.actor_type}:{log.actor_id ?? '—'}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <LoadMore query={audit} data-testid="audit-load-more" />
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function OverviewPage() {
  const ws = useWorkspaceId()
  const stats = useStats(ws)
  const { data: workspaces } = useWorkspaces()
  const wsName = workspaces?.find((w) => w.id === ws)?.name

  return (
    <>
      <PageHeader
        title="Overview"
        description={wsName ? `Workspace “${wsName}” — memory health, learning and retrieval at a glance.` : undefined}
      />
      {stats.isPending ? (
        <LoadingState rows={4} />
      ) : stats.isError ? (
        <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Key metrics" data-testid="overview-stats">
            <StatTile
              id="active-memories"
              label="Active memories"
              value={formatCompact(stats.data.memories_by_status.active ?? 0)}
              hint={`${formatNumber(sumValues(stats.data.memories_by_status))} total`}
              to="/memories?status=active"
            />
            <StatTile
              id="pending-review"
              label="Pending review"
              value={formatCompact(stats.data.pending_review)}
              hint="Candidates awaiting a reviewer"
              to="/memories?status=candidate&review_state=pending"
            />
            <StatTile
              id="open-conflicts"
              label="Open conflicts"
              value={formatCompact(stats.data.conflicts_by_status.open ?? 0)}
              hint={`${formatNumber(stats.data.conflicts_by_status.resolved ?? 0)} resolved`}
              to="/conflicts"
            />
            <StatTile
              id="retrievals-24h"
              label="Retrievals (24h)"
              value={formatCompact(stats.data.retrieval_24h.count)}
              hint={`avg ${formatNumber(stats.data.retrieval_24h.avg_latency_ms)} ms · ${formatNumber(
                stats.data.retrieval_24h.avg_context_tokens,
              )} tokens`}
              to="/settings?tab=traces"
            />
            <StatTile
              id="experiences"
              label="Experiences"
              value={formatCompact(sumValues(stats.data.experiences_by_outcome))}
              hint={`${formatNumber(stats.data.experiences_by_outcome.success ?? 0)} successful`}
              to="/experiences"
            />
            <StatTile
              id="dreams"
              label="Dream jobs"
              value={formatCompact(sumValues(stats.data.dreams_by_status))}
              hint={`${formatNumber((stats.data.dreams_by_status.queued ?? 0) + (stats.data.dreams_by_status.running ?? 0))} in progress`}
              to="/dreams"
            />
            <StatTile
              id="feedback"
              label="Feedback"
              value={formatCompact(sumValues(stats.data.feedback_by_value))}
              hint={`${formatNumber(stats.data.feedback_by_value.helpful ?? 0)} helpful`}
            />
            <StatTile
              id="dead-jobs"
              label="Dead jobs"
              value={formatCompact(stats.data.jobs_by_status.dead ?? 0)}
              hint={`${formatNumber(stats.data.jobs_by_status.queued ?? 0)} queued`}
              to="/settings?tab=jobs"
            />
          </section>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Distributions">
            <DistributionCard
              title="Memories by status"
              data={stats.data.memories_by_status}
              testId="dist-memories-status"
              order={MEMORY_STATUSES}
            />
            <DistributionCard
              title="Active memories by type"
              data={stats.data.memories_by_type}
              testId="dist-memories-type"
            />
            <DistributionCard
              title="Active memories by layer"
              description="L3 semantic · L4 organizational"
              data={stats.data.memories_by_layer}
              testId="dist-memories-layer"
              formatLabel={(k) => `L${k}`}
            />
            <DistributionCard
              title="Experiences by outcome"
              data={stats.data.experiences_by_outcome}
              testId="dist-experiences-outcome"
              order={OUTCOMES}
            />
            <DistributionCard title="Feedback by value" data={stats.data.feedback_by_value} testId="dist-feedback" />
            <DistributionCard title="Jobs by status" data={stats.data.jobs_by_status} testId="dist-jobs" />
            <DistributionCard title="Dreams by status" data={stats.data.dreams_by_status} testId="dist-dreams" />
            <DistributionCard title="Conflicts by status" data={stats.data.conflicts_by_status} testId="dist-conflicts" />
          </section>
        </>
      )}
      <AuditCard ws={ws} />
    </>
  )
}
