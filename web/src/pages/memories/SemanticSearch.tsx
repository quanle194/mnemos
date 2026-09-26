import { Search } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '@/api/client'
import { useSearchMemories } from '@/api/hooks/memories'
import { MEMORY_TYPES, type MemoryStatus, type MemoryType, type SearchIn } from '@/api/types'
import { useWorkspaceId } from '@/auth/session-context'
import { ScoreBar } from '@/components/common/ScoreBar'
import { EmptyState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { formatScore, humanize, shortId, truncate } from '@/lib/format'

const STATUS_PRESETS: Record<string, MemoryStatus[] | null> = {
  retrievable: null,
  with_candidates: ['active', 'validated', 'candidate'],
  all: ['candidate', 'validated', 'active', 'disputed', 'superseded', 'archived', 'rejected'],
}

export function SemanticSearch() {
  const ws = useWorkspaceId()
  const search = useSearchMemories()
  const [query, setQuery] = useState('')
  const [type, setType] = useState<MemoryType | ''>('')
  const [preset, setPreset] = useState('retrievable')
  const [limit, setLimit] = useState(10)

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return
    const body: SearchIn = {
      workspace_id: ws,
      query: query.trim(),
      limit,
      types: type ? [type] : null,
      statuses: STATUS_PRESETS[preset] ?? null,
    }
    search.mutate(body)
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <form
          onSubmit={onSubmit}
          className="grid grid-cols-2 items-end gap-3 md:grid-cols-6"
          data-testid="memory-search-form"
          role="search"
        >
          <div className="col-span-2 flex flex-col gap-1.5 md:col-span-3">
            <Label htmlFor="memory-search-input">Query</Label>
            <Input
              id="memory-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. how do we run database migrations?"
              data-testid="memory-search-input"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="memory-search-type">Type</Label>
            <NativeSelect
              id="memory-search-type"
              value={type}
              onChange={(e) => setType(e.target.value as MemoryType | '')}
              data-testid="memory-search-type"
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
            <Label htmlFor="memory-search-statuses">Statuses</Label>
            <NativeSelect
              id="memory-search-statuses"
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
              data-testid="memory-search-statuses"
            >
              <option value="retrievable">Retrievable (default)</option>
              <option value="with_candidates">Include candidates</option>
              <option value="all">All statuses</option>
            </NativeSelect>
          </div>
          <div className="flex gap-2">
            <div className="flex w-20 flex-col gap-1.5">
              <Label htmlFor="memory-search-limit">Limit</Label>
              <Input
                id="memory-search-limit"
                type="number"
                min={1}
                max={100}
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Math.min(100, Number(e.target.value) || 10)))}
              />
            </div>
            <Button
              type="submit"
              className="self-end"
              disabled={search.isPending}
              data-testid="memory-search-submit"
            >
              <Search /> {search.isPending ? 'Searching…' : 'Search'}
            </Button>
          </div>
        </form>

        {search.isError ? (
          <Alert variant="destructive" data-testid="memory-search-error">
            <AlertDescription>{errorMessage(search.error)}</AlertDescription>
          </Alert>
        ) : null}

        {search.data ? (
          <div className="flex flex-col gap-3" data-testid="memory-search-results">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{search.data.items.length} result(s)</span>
              <span aria-hidden>·</span>
              <Link
                to={`/traces/${search.data.retrieval_trace_id}`}
                className="font-mono text-primary hover:underline"
                data-testid="memory-search-trace"
              >
                trace {shortId(search.data.retrieval_trace_id)}
              </Link>
              {Object.keys(search.data.weights).length > 0 ? (
                <span title="Ranking weights configured on the server">
                  · weights{' '}
                  {Object.entries(search.data.weights)
                    .map(([k, v]) => `${k}=${formatScore(v)}`)
                    .join(', ')}
                </span>
              ) : null}
            </div>
            {search.data.items.length === 0 ? (
              <EmptyState title="No memories matched this query" />
            ) : (
              search.data.items.map((item, idx) => (
                <article
                  key={item.memory.id}
                  className="grid gap-3 rounded-lg border p-4 md:grid-cols-[1fr_18rem]"
                  data-testid="search-result"
                  data-id={item.memory.id}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">#{idx + 1}</span>
                      <Link
                        to={`/memories/${item.memory.id}`}
                        className="font-medium hover:text-primary hover:underline"
                      >
                        {item.memory.title}
                      </Link>
                      <Badge variant="outline" className="capitalize">
                        {item.memory.type}
                      </Badge>
                      <StatusBadge kind="memory" value={item.memory.status} />
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{truncate(item.memory.content, 320)}</p>
                    {item.reasons.length > 0 ? (
                      <ul
                        className="mt-2 flex flex-wrap gap-1.5"
                        data-testid="search-result-reasons"
                        aria-label="Reasons"
                      >
                        {item.reasons.map((r) => (
                          <li key={r}>
                            <Badge variant="secondary" className="font-normal">
                              {r}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-1.5" data-testid="search-result-breakdown">
                    <div className="flex items-baseline justify-between">
                      <span className="text-xs text-muted-foreground">Total score</span>
                      <span className="tabular text-lg font-semibold" data-testid="search-result-score">
                        {formatScore(item.score, 3)}
                      </span>
                    </div>
                    {Object.entries(item.scores)
                      .filter(([k]) => k !== 'total')
                      .map(([k, v]) => (
                        <ScoreBar key={k} label={humanize(k)} value={v} />
                      ))}
                  </div>
                </article>
              ))
            )}
          </div>
        ) : !search.isPending && !search.isError ? (
          <p className="text-sm text-muted-foreground">
            Hybrid retrieval (semantic + lexical + scope + trust + recency + utility). Each search records a
            retrieval trace.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
