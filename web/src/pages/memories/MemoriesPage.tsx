import { Plus, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useMemoryList } from '@/api/hooks/memories'
import {
  MEMORY_STATUSES,
  MEMORY_TYPES,
  REVIEW_STATES,
  type Memory,
  type MemoryListParams,
  type MemoryStatus,
  type MemoryType,
  type ReviewState,
} from '@/api/types'
import { useWorkspaceId } from '@/auth/session-context'
import { usePermissions } from '@/auth/permissions'
import { LoadMore } from '@/components/common/LoadMore'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { TimeAgo } from '@/components/common/TimeAgo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatScore, humanize, truncate } from '@/lib/format'
import { useDebouncedValue } from '@/lib/hooks'
import { ProposeMemoryDialog } from './ProposeMemoryDialog'
import { SemanticSearch } from './SemanticSearch'

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

/** Filters live in the URL so views are shareable and survive reloads. */
function useMemoryFilters() {
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => {
    const layerRaw = params.get('layer')
    return {
      status: pick<MemoryStatus>(params.get('status'), MEMORY_STATUSES),
      type: pick<MemoryType>(params.get('type'), MEMORY_TYPES),
      review_state: pick<ReviewState>(params.get('review_state'), REVIEW_STATES),
      layer: layerRaw === '3' || layerRaw === '4' ? Number(layerRaw) : undefined,
      q: params.get('q') ?? '',
    }
  }, [params])
  const setFilter = (key: string, value: string | undefined) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value) next.set(key, value)
        else next.delete(key)
        return next
      },
      { replace: true },
    )
  }
  return { filters, setFilter, params, setParams }
}

function MemoryFilters() {
  const { filters, setFilter, setParams } = useMemoryFilters()
  const [q, setQ] = useState(filters.q)
  const debouncedQ = useDebouncedValue(q, 300)
  useEffect(() => {
    if (debouncedQ !== filters.q) setFilter('q', debouncedQ.trim() || undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to the debounced text
  }, [debouncedQ])
  const active = Boolean(filters.status || filters.type || filters.layer || filters.review_state || filters.q)

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-6" data-testid="memory-filters" role="search">
      <div className="col-span-2 flex flex-col gap-1.5">
        <Label htmlFor="memory-filter-q">Text</Label>
        <Input
          id="memory-filter-q"
          value={q}
          placeholder="Title or content contains…"
          onChange={(e) => setQ(e.target.value)}
          data-testid="memory-filter-q"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="memory-filter-status">Status</Label>
        <NativeSelect
          id="memory-filter-status"
          value={filters.status ?? ''}
          onChange={(e) => setFilter('status', e.target.value || undefined)}
          data-testid="memory-filter-status"
        >
          <option value="">Any status</option>
          {MEMORY_STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="memory-filter-type">Type</Label>
        <NativeSelect
          id="memory-filter-type"
          value={filters.type ?? ''}
          onChange={(e) => setFilter('type', e.target.value || undefined)}
          data-testid="memory-filter-type"
        >
          <option value="">Any type</option>
          {MEMORY_TYPES.map((t) => (
            <option key={t} value={t}>
              {humanize(t)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="memory-filter-layer">Layer</Label>
        <NativeSelect
          id="memory-filter-layer"
          value={filters.layer ? String(filters.layer) : ''}
          onChange={(e) => setFilter('layer', e.target.value || undefined)}
          data-testid="memory-filter-layer"
        >
          <option value="">Any layer</option>
          <option value="3">L3 semantic</option>
          <option value="4">L4 organizational</option>
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="memory-filter-review">Review</Label>
        <NativeSelect
          id="memory-filter-review"
          value={filters.review_state ?? ''}
          onChange={(e) => setFilter('review_state', e.target.value || undefined)}
          data-testid="memory-filter-review"
        >
          <option value="">Any review state</option>
          {REVIEW_STATES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </NativeSelect>
      </div>
      {active ? (
        <div className="col-span-2 md:col-span-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ('')
              setParams(
                (prev) => {
                  const next = new URLSearchParams()
                  const tab = prev.get('tab')
                  if (tab) next.set('tab', tab)
                  return next
                },
                { replace: true },
              )
            }}
            data-testid="memory-filter-clear"
          >
            <X /> Clear filters
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function MemoryTable({ memories }: { memories: Memory[] }) {
  return (
    <Table data-testid="memory-list">
      <TableHeader>
        <TableRow>
          <TableHead>Memory</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Layer</TableHead>
          <TableHead>Scope</TableHead>
          <TableHead className="text-right">Conf.</TableHead>
          <TableHead className="text-right">Trust</TableHead>
          <TableHead className="text-right">Utility</TableHead>
          <TableHead className="text-right">v</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {memories.map((m) => (
          <TableRow key={m.id} data-testid="memory-row" data-id={m.id} data-status={m.status}>
            <TableCell className="max-w-md min-w-56">
              <Link
                to={`/memories/${m.id}`}
                className="font-medium text-foreground hover:text-primary hover:underline"
                data-testid="memory-row-link"
              >
                {m.title}
              </Link>
              <p className="line-clamp-1 text-xs text-muted-foreground">{truncate(m.content, 160)}</p>
            </TableCell>
            <TableCell className="capitalize">{m.type}</TableCell>
            <TableCell>
              <div className="flex flex-col items-start gap-1">
                <StatusBadge kind="memory" value={m.status} data-testid="memory-row-status" />
                {m.review_state === 'pending' ? <StatusBadge kind="review" value="pending" /> : null}
              </div>
            </TableCell>
            <TableCell>
              <Badge variant="outline">L{m.layer}</Badge>
            </TableCell>
            <TableCell className="capitalize">{m.scope_type}</TableCell>
            <TableCell className="tabular text-right">{formatScore(m.confidence)}</TableCell>
            <TableCell className="tabular text-right">{formatScore(m.trust_score)}</TableCell>
            <TableCell className="tabular text-right">{formatScore(m.utility_score)}</TableCell>
            <TableCell className="tabular text-right">{m.version}</TableCell>
            <TableCell className="whitespace-nowrap text-muted-foreground">
              <TimeAgo iso={m.updated_at} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function BrowseMemories() {
  const ws = useWorkspaceId()
  const { filters } = useMemoryFilters()
  const params: MemoryListParams = {
    workspace_id: ws,
    status: filters.status,
    type: filters.type,
    layer: filters.layer,
    review_state: filters.review_state,
    q: filters.q || undefined,
  }
  const list = useMemoryList(params)
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <MemoryFilters />
        {list.isPending ? (
          <LoadingState rows={5} />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : list.items.length === 0 ? (
          <EmptyState title="No memories match these filters">
            Agents propose memories through experiences, the SDK/MCP or the “Propose memory” button.
          </EmptyState>
        ) : (
          <>
            <MemoryTable memories={list.items} />
            <LoadMore query={list} data-testid="memory-load-more" />
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function MemoriesPage() {
  const { params, setParams } = useMemoryFilters()
  const { can } = usePermissions()
  const [proposeOpen, setProposeOpen] = useState(false)
  const tab = params.get('tab') === 'search' ? 'search' : 'browse'

  return (
    <>
      <PageHeader
        title="Memories"
        description="Governed knowledge with provenance, trust and lifecycle."
        actions={
          can('memory:propose') ? (
            <Button onClick={() => setProposeOpen(true)} data-testid="propose-memory-open">
              <Plus /> Propose memory
            </Button>
          ) : null
        }
      />
      <Tabs
        value={tab}
        onValueChange={(v) =>
          setParams(
            (prev) => {
              const next = new URLSearchParams(prev)
              if (v === 'search') next.set('tab', 'search')
              else next.delete('tab')
              return next
            },
            { replace: true },
          )
        }
      >
        <TabsList>
          <TabsTrigger value="browse" data-testid="memories-tab-browse">
            Browse
          </TabsTrigger>
          <TabsTrigger value="search" data-testid="memories-tab-search">
            <Search className="size-3.5" /> Semantic search
          </TabsTrigger>
        </TabsList>
        <TabsContent value="browse">
          <BrowseMemories />
        </TabsContent>
        <TabsContent value="search">
          <SemanticSearch />
        </TabsContent>
      </Tabs>
      {can('memory:propose') ? (
        <ProposeMemoryDialog open={proposeOpen} onOpenChange={setProposeOpen} />
      ) : null}
    </>
  )
}
