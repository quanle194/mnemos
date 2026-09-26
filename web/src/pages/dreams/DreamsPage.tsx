import { MoonStar } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { isDreamActive, useDreamList, useRequestDream } from '@/api/hooks/dreams'
import { DREAM_MODES, type DreamMode } from '@/api/types'
import { usePermissions } from '@/auth/permissions'
import { useWorkspaceId } from '@/auth/session-context'
import { IdText } from '@/components/common/IdText'
import { LoadMore } from '@/components/common/LoadMore'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { TimeAgo } from '@/components/common/TimeAgo'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { humanize } from '@/lib/format'

const DREAM_MODE_HELP: Record<DreamMode, string> = {
  reflection: 'Summarize durable lessons from recent experiences.',
  deduplication: 'Cluster near-duplicate memories and propose/apply a canonical one.',
  pattern: 'Find repeated failures/successes across trajectories.',
  contradiction: 'Detect unresolved conflicting knowledge and open conflicts.',
  generalization: 'Propose broader rules from repeated evidence (calibrated confidence).',
  compression: 'Consolidate redundant active memories, superseding originals.',
}

function DreamTrigger() {
  const ws = useWorkspaceId()
  const navigate = useNavigate()
  const request = useRequestDream()
  const [mode, setMode] = useState<DreamMode>('reflection')
  const [dedupe, setDedupe] = useState(false)
  return (
    <Card>
      <CardHeader className="flex-col">
        <CardTitle className="text-base">Run a dream</CardTitle>
        <CardDescription>Dreams run asynchronously in workers and never block retrieval.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          data-testid="dream-form"
          onSubmit={(e) => {
            e.preventDefault()
            request.mutate(
              { workspace_id: ws, mode, dedupe_window: dedupe },
              {
                onSuccess: (d) => {
                  toast.success(`Dream ${d.mode} ${d.status}`)
                  void navigate(`/dreams/${d.id}`)
                },
              },
            )
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dream-mode">Mode</Label>
            <NativeSelect
              id="dream-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as DreamMode)}
              data-testid="dream-mode"
              aria-describedby="dream-mode-help"
            >
              {DREAM_MODES.map((m) => (
                <option key={m} value={m}>
                  {humanize(m)}
                </option>
              ))}
            </NativeSelect>
            <p id="dream-mode-help" className="text-xs text-muted-foreground">
              {DREAM_MODE_HELP[mode]}
            </p>
          </div>
          <label className="flex items-start gap-2 text-sm" htmlFor="dream-dedupe">
            <Checkbox
              id="dream-dedupe"
              checked={dedupe}
              onChange={(e) => setDedupe(e.target.checked)}
              className="mt-0.5"
              data-testid="dream-dedupe"
            />
            <span>
              Skip if this exact input window was already dreamed
              <span className="block text-xs text-muted-foreground">
                Idempotent re-runs return the earlier job.
              </span>
            </span>
          </label>
          {request.isError ? (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(request.error)}</AlertDescription>
            </Alert>
          ) : null}
          <div>
            <Button type="submit" disabled={request.isPending} data-testid="dream-submit">
              <MoonStar /> {request.isPending ? 'Queuing…' : 'Start dream'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

export function DreamsPage() {
  const ws = useWorkspaceId()
  const { can } = usePermissions()
  const list = useDreamList(ws)
  const anyActive = list.items.some((d) => isDreamActive(d))
  return (
    <>
      <PageHeader
        title="Dreams"
        description="Asynchronous reflection, consolidation and contradiction analysis."
      />
      <div className="grid gap-5 lg:grid-cols-3">
        {can('dream:run') ? (
          <div className="lg:col-span-1">
            <DreamTrigger />
          </div>
        ) : null}
        <Card className={can('dream:run') ? 'lg:col-span-2' : 'lg:col-span-3'}>
          <CardHeader>
            <CardTitle className="text-base">Dream jobs</CardTitle>
            {anyActive ? (
              <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
                Refresh
              </Button>
            ) : null}
          </CardHeader>
          <CardContent>
            {list.isPending ? (
              <LoadingState rows={4} />
            ) : list.isError ? (
              <ErrorState error={list.error} onRetry={() => void list.refetch()} />
            ) : list.items.length === 0 ? (
              <EmptyState title="No dreams yet">
                Dreams are triggered on schedule, by thresholds or manually.
              </EmptyState>
            ) : (
              <>
                <Table data-testid="dream-list">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Mode</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Trigger</TableHead>
                      <TableHead>Summary</TableHead>
                      <TableHead>Created</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {list.items.map((d) => {
                      const stats = (d.result_json.stats ?? {}) as Record<string, unknown>
                      return (
                        <TableRow key={d.id} data-testid="dream-row" data-id={d.id}>
                          <TableCell>
                            <Link
                              to={`/dreams/${d.id}`}
                              className="font-medium capitalize hover:text-primary hover:underline"
                            >
                              {d.mode}
                            </Link>{' '}
                            <IdText id={d.id} className="text-muted-foreground" />
                          </TableCell>
                          <TableCell>
                            <StatusBadge kind="dream" value={d.status} data-testid="dream-row-status" />
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{d.trigger_type}</Badge>
                          </TableCell>
                          <TableCell className="max-w-72 text-xs text-muted-foreground">
                            {d.error
                              ? d.error.slice(0, 120)
                              : Object.entries(stats)
                                  .slice(0, 4)
                                  .map(([k, v]) => `${humanize(k)}: ${String(v)}`)
                                  .join(' · ') || '—'}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            <TimeAgo iso={d.created_at} />
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
                <LoadMore query={list} data-testid="dream-load-more" />
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  )
}
