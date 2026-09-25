import { Minus, Plus, RotateCcw } from 'lucide-react'
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { useGraph } from '@/api/hooks/ops'
import type { Graph, GraphNode } from '@/api/types'
import { useWorkspaceId } from '@/auth/session-context'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatScore, humanize, truncate } from '@/lib/format'
import { computeForceLayout, validEdges, type Point } from '@/lib/graph-layout'
import {
  nodeRadius,
  nodeStyle,
  STATUS_LEGEND,
  TYPE_LEGEND,
  typeFamily,
  type ColorMode,
} from '@/lib/graph-style'

const WIDTH = 1000
const HEIGHT = 680

interface View {
  x: number
  y: number
  scale: number
}

function GraphCanvas({ graph, mode }: { graph: Graph; mode: ColorMode }) {
  const navigate = useNavigate()
  const [hover, setHover] = useState<string | null>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const edges = useMemo(() => validEdges(graph.nodes, graph.edges), [graph])
  const allEdges = useMemo(() => {
    const ids = new Set(graph.nodes.map((n) => n.id))
    return graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
  }, [graph])
  const positions = useMemo(
    () => computeForceLayout(graph.nodes, edges, { width: WIDTH, height: HEIGHT, padding: 40 }),
    [graph.nodes, edges],
  )
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const e of allEdges) {
      if (!m.has(e.source)) m.set(e.source, new Set())
      if (!m.has(e.target)) m.set(e.target, new Set())
      m.get(e.source)!.add(e.target)
      m.get(e.target)!.add(e.source)
    }
    return m
  }, [allEdges])

  const showAllLabels = graph.nodes.length <= 40
  const showEdgeLabels = allEdges.length <= 60
  const hovered = hover ? graph.nodes.find((n) => n.id === hover) : undefined
  const isDim = (id: string) => hover !== null && hover !== id && !neighbors.get(hover)?.has(id)

  const zoom = (factor: number) =>
    setView((v) => {
      const scale = Math.max(0.4, Math.min(4, v.scale * factor))
      // keep the centre fixed
      const cx = WIDTH / 2
      const cy = HEIGHT / 2
      return { scale, x: cx - ((cx - v.x) * scale) / v.scale, y: cy - ((cy - v.y) * scale) / v.scale }
    })

  const toSvgDelta = (dx: number, dy: number) => {
    const rect = svgRef.current?.getBoundingClientRect()
    const k = rect && rect.width > 0 ? WIDTH / rect.width : 1
    return { dx: dx * k, dy: dy * k }
  }

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest('[data-node]')) return
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d) return
    const { dx, dy } = toSvgDelta(e.clientX - d.x, e.clientY - d.y)
    setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }))
  }
  const onPointerUp = () => {
    drag.current = null
  }

  const pos = (id: string): Point => positions.get(id) ?? { x: WIDTH / 2, y: HEIGHT / 2 }

  return (
    <div className="relative">
      <div className="absolute top-2 right-2 z-10 flex gap-1">
        <Button variant="outline" size="icon" aria-label="Zoom in" onClick={() => zoom(1.25)}>
          <Plus />
        </Button>
        <Button variant="outline" size="icon" aria-label="Zoom out" onClick={() => zoom(0.8)}>
          <Minus />
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Reset view"
          onClick={() => setView({ x: 0, y: 0, scale: 1 })}
        >
          <RotateCcw />
        </Button>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-[62vh] min-h-80 w-full cursor-grab touch-none rounded-lg border bg-card select-none active:cursor-grabbing"
        role="group"
        aria-label={`Knowledge graph with ${graph.nodes.length} memories and ${allEdges.length} relations`}
        data-testid="graph-svg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <defs>
          <marker
            id="graph-arrow"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: 'var(--muted-foreground)' }} />
          </marker>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          <g>
            {allEdges.map((e) => {
              const a = pos(e.source)
              const b = pos(e.target)
              const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1
              const target = graph.nodes.find((n) => n.id === e.target)
              const r = target ? nodeRadius(target.utility) + 3 : 10
              const ex = b.x - ((b.x - a.x) / dist) * r
              const ey = b.y - ((b.y - a.y) / dist) * r
              const dim = hover !== null && e.source !== hover && e.target !== hover
              return (
                <g key={e.id} data-testid="graph-edge" data-relation={e.relation} opacity={dim ? 0.15 : 1}>
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={ex}
                    y2={ey}
                    strokeWidth={1.5}
                    strokeDasharray={e.relation === 'contradicts' ? '5 4' : undefined}
                    markerEnd="url(#graph-arrow)"
                    style={{ stroke: 'var(--muted-foreground)', strokeOpacity: 0.55 }}
                  />
                  {showEdgeLabels || (hover && (e.source === hover || e.target === hover)) ? (
                    <text
                      x={(a.x + b.x) / 2}
                      y={(a.y + b.y) / 2 - 4}
                      textAnchor="middle"
                      fontSize={10}
                      style={{
                        fill: 'var(--muted-foreground)',
                        paintOrder: 'stroke',
                        stroke: 'var(--card)',
                        strokeWidth: 3,
                      }}
                    >
                      {e.relation.replace('_', ' ')}
                    </text>
                  ) : null}
                </g>
              )
            })}
          </g>
          <g>
            {graph.nodes.map((n) => {
              const p = pos(n.id)
              const r = nodeRadius(n.utility)
              const { color, hollow } = nodeStyle(mode, n)
              const labelled = showAllLabels || hover === n.id
              return (
                <g
                  key={n.id}
                  data-node
                  data-testid="graph-node"
                  data-id={n.id}
                  data-status={n.status}
                  transform={`translate(${p.x} ${p.y})`}
                  role="link"
                  tabIndex={0}
                  aria-label={`${n.title} (${n.type}, ${n.status})`}
                  className="cursor-pointer outline-none focus-visible:[&>circle:first-of-type]:stroke-[var(--ring)]"
                  opacity={isDim(n.id) ? 0.25 : 1}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(n.id)}
                  onBlur={() => setHover(null)}
                  onClick={() => void navigate(`/memories/${n.id}`)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault()
                      void navigate(`/memories/${n.id}`)
                    }
                  }}
                >
                  <circle r={r + 6} style={{ fill: 'transparent', stroke: 'transparent', strokeWidth: 3 }} />
                  {n.layer === 4 ? (
                    <circle r={r + 3} style={{ fill: 'none', stroke: color, strokeWidth: 1.5 }} />
                  ) : null}
                  <circle
                    r={r}
                    style={{
                      fill: hollow ? 'var(--card)' : color,
                      stroke: hollow ? color : 'var(--card)',
                      strokeWidth: hollow ? 2.5 : 2,
                    }}
                  />
                  {labelled ? (
                    <text
                      x={r + 4}
                      y={4}
                      fontSize={11}
                      style={{
                        fill: 'var(--foreground)',
                        paintOrder: 'stroke',
                        stroke: 'var(--card)',
                        strokeWidth: 3,
                      }}
                    >
                      {truncate(n.title, 28)}
                    </text>
                  ) : null}
                  <title>{`${n.title}\n${n.type} · ${n.status} · L${n.layer}\nconfidence ${formatScore(n.confidence)} · utility ${formatScore(n.utility)}`}</title>
                </g>
              )
            })}
          </g>
        </g>
      </svg>
      {hovered ? (
        <div
          className="pointer-events-none absolute bottom-2 left-2 max-w-sm rounded-md border bg-popover px-3 py-2 text-xs shadow-md"
          data-testid="graph-tooltip"
        >
          <div className="font-medium text-foreground">{hovered.title}</div>
          <div className="text-muted-foreground">
            {hovered.type} · {hovered.status} · L{hovered.layer} · confidence{' '}
            {formatScore(hovered.confidence)} · utility {formatScore(hovered.utility)} ·{' '}
            {neighbors.get(hovered.id)?.size ?? 0} relation(s)
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Legend({ mode }: { mode: ColorMode }) {
  const entries = mode === 'status' ? STATUS_LEGEND : TYPE_LEGEND
  return (
    <ul
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
      data-testid="graph-legend"
    >
      {entries.map((e) => (
        <li key={e.key} className="flex items-center gap-1.5">
          <svg width="12" height="12" aria-hidden>
            <circle
              cx="6"
              cy="6"
              r="4.5"
              style={{
                fill: e.hollow ? 'transparent' : e.color,
                stroke: e.color,
                strokeWidth: e.hollow ? 2 : 0,
              }}
            />
          </svg>
          {e.label}
          {mode === 'type' ? <span className="opacity-70">({TYPE_LEGEND_TYPES[e.key]})</span> : null}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <svg width="24" height="8" aria-hidden>
          <line x1="0" y1="4" x2="24" y2="4" strokeDasharray="5 4" style={{ stroke: 'currentColor' }} />
        </svg>
        contradicts
      </li>
      <li>Size = utility · ring = L4</li>
    </ul>
  )
}

const TYPE_LEGEND_TYPES: Record<string, string> = {
  knowledge: 'fact, context, relationship, preference',
  procedural: 'procedure',
  policy: 'rule, constraint, decision',
  experiential: 'lesson, pattern, success, failure, warning',
}

function NodeTable({ nodes, degree }: { nodes: GraphNode[]; degree: Map<string, number> }) {
  return (
    <details className="rounded-lg border px-4 py-2">
      <summary className="cursor-pointer text-sm font-medium">Table view ({nodes.length} memories)</summary>
      <Table data-testid="graph-table" className="mt-2">
        <TableHeader>
          <TableRow>
            <TableHead>Memory</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Layer</TableHead>
            <TableHead className="text-right">Relations</TableHead>
            <TableHead className="text-right">Utility</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {nodes.map((n) => (
            <TableRow key={n.id}>
              <TableCell>
                <Link to={`/memories/${n.id}`} className="hover:text-primary hover:underline">
                  {n.title}
                </Link>
              </TableCell>
              <TableCell className="capitalize">
                {n.type}{' '}
                <span className="text-xs text-muted-foreground">({humanize(typeFamily(n.type))})</span>
              </TableCell>
              <TableCell>
                <StatusBadge kind="memory" value={n.status} />
              </TableCell>
              <TableCell>L{n.layer}</TableCell>
              <TableCell className="tabular text-right">{degree.get(n.id) ?? 0}</TableCell>
              <TableCell className="tabular text-right">{formatScore(n.utility)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </details>
  )
}

export function GraphPage() {
  const ws = useWorkspaceId()
  const [includeInactive, setIncludeInactive] = useState(false)
  const [mode, setMode] = useState<ColorMode>('status')
  const q = useGraph(ws, includeInactive)
  const degree = useMemo(() => {
    const d = new Map<string, number>()
    for (const e of q.data?.edges ?? []) {
      d.set(e.source, (d.get(e.source) ?? 0) + 1)
      d.set(e.target, (d.get(e.target) ?? 0) + 1)
    }
    return d
  }, [q.data])

  return (
    <>
      <PageHeader
        title="Knowledge graph"
        description="Memories and their relations. Click a node to open the memory; drag to pan."
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex w-44 flex-col gap-1.5">
              <Label htmlFor="graph-color-mode">Color by</Label>
              <NativeSelect
                id="graph-color-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as ColorMode)}
                data-testid="graph-color-mode"
              >
                <option value="status">Status</option>
                <option value="type">Type family</option>
              </NativeSelect>
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm" htmlFor="graph-include-inactive">
              <Checkbox
                id="graph-include-inactive"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
                data-testid="graph-include-inactive"
              />
              Include candidates, archived and rejected
            </label>
            {q.data ? (
              <div className="ml-auto flex gap-2 pb-1">
                <Badge variant="outline" data-testid="graph-node-count">
                  {q.data.nodes.length} nodes
                </Badge>
                <Badge variant="outline" data-testid="graph-edge-count">
                  {q.data.edges.length} edges
                </Badge>
              </div>
            ) : null}
          </div>
          <Legend mode={mode} />
          {q.isPending ? (
            <LoadingState rows={6} />
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => void q.refetch()} />
          ) : q.data.nodes.length === 0 ? (
            <EmptyState title="No memories to graph yet" />
          ) : (
            <>
              <GraphCanvas graph={q.data} mode={mode} />
              <NodeTable nodes={q.data.nodes} degree={degree} />
            </>
          )}
        </CardContent>
      </Card>
    </>
  )
}
