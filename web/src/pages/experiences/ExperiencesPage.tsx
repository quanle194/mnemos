import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useEpisodeList, useExperienceList } from '@/api/hooks/experiences'
import { OUTCOMES } from '@/api/types'
import { usePermissions } from '@/auth/permissions'
import { useWorkspaceId } from '@/auth/session-context'
import { LoadMore } from '@/components/common/LoadMore'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { TimeAgo } from '@/components/common/TimeAgo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatScore, humanize, truncate } from '@/lib/format'
import { ExperienceFormDialog } from './ExperienceFormDialog'

function ExperienceList() {
  const ws = useWorkspaceId()
  const [outcome, setOutcome] = useState('')
  const list = useExperienceList(ws, outcome || undefined)
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex max-w-56 flex-col gap-1.5">
          <Label htmlFor="experience-filter-outcome">Outcome</Label>
          <NativeSelect
            id="experience-filter-outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            data-testid="experience-filter-outcome"
          >
            <option value="">Any outcome</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {humanize(o)}
              </option>
            ))}
          </NativeSelect>
        </div>
        {list.isPending ? (
          <LoadingState rows={5} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.items.length === 0 ? (
          <EmptyState title="No experiences recorded">
            Agents record experiences via the SDK, MCP <code>memory_experience</code> tool or this dashboard.
          </EmptyState>
        ) : (
          <>
            <Table data-testid="experience-list">
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Learning</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Importance</TableHead>
                  <TableHead className="text-right">Confidence</TableHead>
                  <TableHead>Recorded</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.items.map((e) => (
                  <TableRow key={e.id} data-testid="experience-row" data-id={e.id}>
                    <TableCell className="max-w-md min-w-56">
                      <Link
                        to={`/experiences/${e.id}`}
                        className="font-medium hover:text-primary hover:underline"
                        data-testid="experience-row-link"
                      >
                        {truncate(e.task, 120)}
                      </Link>
                      {e.result ? (
                        <p className="line-clamp-1 text-xs text-muted-foreground">
                          {truncate(e.result, 140)}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <StatusBadge kind="outcome" value={e.outcome} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge kind="processing" value={e.processing_status} />
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{e.source}</Badge>
                    </TableCell>
                    <TableCell className="tabular text-right">{formatScore(e.importance)}</TableCell>
                    <TableCell className="tabular text-right">{formatScore(e.confidence)}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      <TimeAgo iso={e.created_at} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <LoadMore query={list} data-testid="experience-load-more" />
          </>
        )}
      </CardContent>
    </Card>
  )
}

function EpisodeList() {
  const ws = useWorkspaceId()
  const list = useEpisodeList(ws)
  return (
    <Card>
      <CardContent>
        {list.isPending ? (
          <LoadingState rows={5} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.items.length === 0 ? (
          <EmptyState title="No episodes yet">
            Episodes group experiences that share a task/session.
          </EmptyState>
        ) : (
          <>
            <Table data-testid="episode-list">
              <TableHeader>
                <TableRow>
                  <TableHead>Summary</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead className="text-right">Experiences</TableHead>
                  <TableHead>Task</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Completed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.items.map((ep) => (
                  <TableRow key={ep.id} data-testid="episode-row" data-id={ep.id}>
                    <TableCell className="max-w-md min-w-56">
                      <Link
                        to={`/episodes/${ep.id}`}
                        className="font-medium hover:text-primary hover:underline"
                      >
                        {truncate(ep.summary || '(no summary)', 140)}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge kind="outcome" value={ep.outcome} />
                    </TableCell>
                    <TableCell className="tabular text-right">{ep.experience_count}</TableCell>
                    <TableCell className="font-mono text-xs">{ep.task_id ?? '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      <TimeAgo iso={ep.started_at} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      <TimeAgo iso={ep.completed_at} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <LoadMore query={list} data-testid="episode-load-more" />
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function ExperiencesPage() {
  const { can } = usePermissions()
  const [open, setOpen] = useState(false)
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'episodes' ? 'episodes' : 'experiences'
  return (
    <>
      <PageHeader
        title="Experiences"
        description="Task trajectories and outcomes that Mnemos learns from."
        actions={
          can('experience:write') ? (
            <Button onClick={() => setOpen(true)} data-testid="experience-create-open">
              <Plus /> Record experience
            </Button>
          ) : null
        }
      />
      <Tabs
        value={tab}
        onValueChange={(v) => setParams(v === 'episodes' ? { tab: 'episodes' } : {}, { replace: true })}
      >
        <TabsList>
          <TabsTrigger value="experiences" data-testid="experiences-tab-experiences">
            Experiences
          </TabsTrigger>
          <TabsTrigger value="episodes" data-testid="experiences-tab-episodes">
            Episodes
          </TabsTrigger>
        </TabsList>
        <TabsContent value="experiences">
          <ExperienceList />
        </TabsContent>
        <TabsContent value="episodes">
          <EpisodeList />
        </TabsContent>
      </Tabs>
      {can('experience:write') ? <ExperienceFormDialog open={open} onOpenChange={setOpen} /> : null}
    </>
  )
}
