import { RefreshCw, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useJobs, useReadiness, useRetryJob, useTraces } from '@/api/hooks/ops'
import { JOB_STATUSES } from '@/api/types'
import { usePermissions } from '@/auth/permissions'
import { useSession, useWorkspaceId } from '@/auth/session-context'
import { IdText } from '@/components/common/IdText'
import { JsonView } from '@/components/common/JsonView'
import { KeyValueGrid } from '@/components/common/KeyValue'
import { LoadMore } from '@/components/common/LoadMore'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { TimeAgo } from '@/components/common/TimeAgo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { envApiUrl } from '@/api/client'
import { formatNumber, humanize, truncate } from '@/lib/format'

function maskKey(key: string | null): string {
  if (!key) return '—'
  const parts = key.split('_')
  if (parts.length >= 3) return `${parts[0]}_${parts[1]}_••••••••`
  return `${key.slice(0, 6)}••••••••`
}

function ConnectionCard() {
  const session = useSession()
  const source = session.apiUrl ? 'set at login' : envApiUrl() ? 'VITE_API_URL' : 'default'
  return (
    <Card data-testid="settings-connection">
      <CardHeader className="flex-col">
        <CardTitle className="text-base">Connection</CardTitle>
        <CardDescription>Sign out to change the API URL or key.</CardDescription>
      </CardHeader>
      <CardContent>
        <KeyValueGrid
          className="lg:grid-cols-3"
          items={[
            {
              label: 'API URL',
              value: <code className="font-mono text-xs">{session.effectiveApiUrl}</code>,
              testId: 'settings-api-url',
            },
            { label: 'Source', value: source },
            { label: 'API key', value: <code className="font-mono text-xs">{maskKey(session.apiKey)}</code> },
          ]}
        />
      </CardContent>
    </Card>
  )
}

function IdentityCard() {
  const { me } = usePermissions()
  if (!me) return null
  return (
    <Card data-testid="settings-identity">
      <CardHeader className="flex-col">
        <CardTitle className="text-base">Identity</CardTitle>
        <CardDescription>
          From GET /v1/me. Actions you lack permission for are hidden in the UI.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <KeyValueGrid
          className="lg:grid-cols-3"
          items={[
            { label: 'Role', value: <span className="capitalize">{me.role}</span>, testId: 'settings-role' },
            { label: 'Actor', value: <code className="font-mono text-xs break-all">{me.actor_id}</code> },
            { label: 'Organization', value: <IdText id={me.organization_id} /> },
            {
              label: 'Workspace access',
              value: me.workspace_ids ? `${me.workspace_ids.length} workspace(s)` : 'All workspaces',
            },
          ]}
        />
        <div>
          <div className="mb-1.5 text-xs text-muted-foreground">Permissions</div>
          <ul className="flex flex-wrap gap-1.5" data-testid="settings-permissions">
            {me.permissions.map((p) => (
              <li key={p}>
                <Badge variant="secondary" className="font-mono">
                  {p}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}

function ReadinessCard() {
  const q = useReadiness()
  const checks = q.data?.checks
  return (
    <Card data-testid="settings-readiness">
      <CardHeader>
        <div>
          <CardTitle className="text-base">Backend readiness</CardTitle>
          <CardDescription>
            GET /health/ready — database, pgvector, migrations, Redis, workers and providers.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
          <RefreshCw className={q.isFetching ? 'animate-spin' : undefined} /> Refresh
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {q.isPending ? (
          <LoadingState rows={3} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Badge
                variant={q.data.status === 'ok' ? 'success' : 'destructive'}
                data-testid="settings-readiness-status"
              >
                {q.data.status}
              </Badge>
              <span className="text-xs text-muted-foreground">auto-refreshes every 15s</span>
            </div>
            <KeyValueGrid
              items={[
                {
                  label: 'Database',
                  value: checks?.database
                    ? checks.database.ok
                      ? 'ok'
                      : `down (${checks.database.error ?? 'error'})`
                    : '—',
                },
                { label: 'pgvector', value: checks?.database?.pgvector ?? '—' },
                {
                  label: 'Migration',
                  value: <code className="font-mono text-xs">{checks?.database?.migration ?? '—'}</code>,
                },
                { label: 'Redis', value: checks?.redis ? (checks.redis.ok ? 'ok' : 'down') : '—' },
                {
                  label: 'LLM provider',
                  value: checks?.providers?.llm ?? '—',
                  testId: 'settings-provider-llm',
                },
                {
                  label: 'Embedding provider',
                  value: checks?.providers?.embedding ?? '—',
                  testId: 'settings-provider-embedding',
                },
                {
                  label: 'Embedding dims',
                  value: formatNumber(checks?.providers?.embedding_dimensions ?? null),
                },
                {
                  label: 'Workers',
                  value: Array.isArray(checks?.workers)
                    ? `${checks.workers.length} live`
                    : typeof checks?.workers === 'number'
                      ? `${checks.workers} live`
                      : '—',
                },
              ]}
            />
            {checks?.queue ? (
              <div>
                <div className="mb-1.5 text-xs text-muted-foreground">Queue depth</div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(checks.queue).map(([k, v]) => (
                    <Badge key={k} variant="outline">
                      {k}: {v}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Raw readiness payload
              </summary>
              <JsonView value={q.data} className="mt-2" />
            </details>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function JobsTab() {
  const ws = useWorkspaceId()
  const { can } = usePermissions()
  const [status, setStatus] = useState('')
  const list = useJobs(ws, status)
  const retry = useRetryJob()
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex max-w-56 flex-col gap-1.5">
          <Label htmlFor="jobs-status">Status</Label>
          <NativeSelect
            id="jobs-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            data-testid="jobs-status"
          >
            <option value="">Any status</option>
            {JOB_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {list.isPending ? (
          <LoadingState rows={4} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.items.length === 0 ? (
          <EmptyState title="No jobs" />
        ) : (
          <>
            <Table data-testid="job-list">
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead>Last error</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.items.map((j) => (
                  <TableRow key={j.id} data-testid="job-row" data-id={j.id} data-status={j.status}>
                    <TableCell>
                      <span className="font-mono text-xs">{j.kind}</span>{' '}
                      <IdText id={j.id} className="text-muted-foreground" />
                    </TableCell>
                    <TableCell>
                      <StatusBadge kind="job" value={j.status} />
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {j.attempts}/{j.max_attempts}
                    </TableCell>
                    <TableCell
                      className="max-w-72 truncate text-xs text-destructive"
                      title={j.last_error ?? ''}
                    >
                      {j.last_error ? truncate(j.last_error, 100) : ''}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      <TimeAgo iso={j.created_at} />
                    </TableCell>
                    <TableCell className="text-right">
                      {j.status === 'dead' && can('memory:review') ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={retry.isPending}
                          onClick={() =>
                            retry.mutate(j.id, {
                              onSuccess: () => toast.success('Job re-queued'),
                              onError: (err) => toast.error(errorMessage(err)),
                            })
                          }
                          data-testid="job-retry"
                        >
                          <RotateCw /> Retry
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <LoadMore query={list} data-testid="job-load-more" />
          </>
        )}
      </CardContent>
    </Card>
  )
}

function TracesTab() {
  const ws = useWorkspaceId()
  const list = useTraces(ws)
  return (
    <Card>
      <CardContent>
        {list.isPending ? (
          <LoadingState rows={4} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.items.length === 0 ? (
          <EmptyState title="No retrieval traces yet">
            Every context/search request records a trace.
          </EmptyState>
        ) : (
          <>
            <Table data-testid="trace-list">
              <TableHeader>
                <TableRow>
                  <TableHead>Query</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Selected</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.items.map((t) => {
                  const selected = Array.isArray(t.selected_json.items) ? t.selected_json.items.length : 0
                  return (
                    <TableRow key={t.id} data-testid="trace-row" data-id={t.id}>
                      <TableCell className="max-w-md">
                        <Link
                          to={`/traces/${t.id}`}
                          className="font-medium hover:text-primary hover:underline"
                        >
                          {truncate(t.query, 100)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{t.kind}</Badge>
                      </TableCell>
                      <TableCell className="tabular text-right">{selected}</TableCell>
                      <TableCell className="tabular text-right">{formatNumber(t.context_tokens)}</TableCell>
                      <TableCell className="tabular text-right">{formatNumber(t.latency_ms)} ms</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        <TimeAgo iso={t.created_at} />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
            <LoadMore query={list} data-testid="trace-load-more" />
          </>
        )}
      </CardContent>
    </Card>
  )
}

const TABS = ['general', 'jobs', 'traces'] as const

export function SettingsPage() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab = (TABS as readonly string[]).includes(raw ?? '') ? (raw as string) : 'general'
  return (
    <>
      <PageHeader
        title="Settings & operations"
        description="Connection, identity, backend health, jobs and retrieval traces."
      />
      <Tabs
        value={tab}
        onValueChange={(v) => setParams(v === 'general' ? {} : { tab: v }, { replace: true })}
      >
        <TabsList>
          <TabsTrigger value="general" data-testid="settings-tab-general">
            General
          </TabsTrigger>
          <TabsTrigger value="jobs" data-testid="settings-tab-jobs">
            Jobs
          </TabsTrigger>
          <TabsTrigger value="traces" data-testid="settings-tab-traces">
            Retrieval traces
          </TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="flex flex-col gap-5">
          <ConnectionCard />
          <IdentityCard />
          <ReadinessCard />
        </TabsContent>
        <TabsContent value="jobs">
          <JobsTab />
        </TabsContent>
        <TabsContent value="traces">
          <TracesTab />
        </TabsContent>
      </Tabs>
    </>
  )
}
