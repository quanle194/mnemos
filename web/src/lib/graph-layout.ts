/**
 * Deterministic force-directed layout (Fruchterman–Reingold with light gravity), pure and dependency-free.
 * Same input (order included) -> same output, which keeps the graph stable across re-renders and testable.
 */

export interface LayoutNode {
  id: string
}

export interface LayoutEdge {
  source: string
  target: string
}

export interface Point {
  x: number
  y: number
}

export interface LayoutOptions {
  width: number
  height: number
  /** Iteration count; defaults scale down with node count to bound O(n²·iterations) work. */
  iterations?: number
  /** Keep nodes this far from the canvas edge. */
  padding?: number
  /** Pull toward the centre so disconnected components stay on screen (0..1). */
  gravity?: number
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

export function defaultIterations(n: number): number {
  if (n <= 1) return 0
  return Math.max(60, Math.min(300, Math.round(40_000 / n)))
}

/** Edges whose endpoints both exist, without self-loops or duplicates (undirected). */
export function validEdges(nodes: LayoutNode[], edges: LayoutEdge[]): LayoutEdge[] {
  const ids = new Set(nodes.map((n) => n.id))
  const seen = new Set<string>()
  const out: LayoutEdge[] = []
  for (const e of edges) {
    if (e.source === e.target || !ids.has(e.source) || !ids.has(e.target)) continue
    const key = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}

export function computeForceLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: LayoutOptions,
): Map<string, Point> {
  const { width, height } = options
  const padding = options.padding ?? 24
  const gravity = options.gravity ?? 0.04
  const n = nodes.length
  const result = new Map<string, Point>()
  if (n === 0) return result
  const cx = width / 2
  const cy = height / 2
  if (n === 1) {
    result.set(nodes[0]!.id, { x: cx, y: cy })
    return result
  }

  const minX = padding
  const maxX = Math.max(padding, width - padding)
  const minY = padding
  const maxY = Math.max(padding, height - padding)
  const area = (maxX - minX) * (maxY - minY)
  const k = 0.75 * Math.sqrt(area / n)

  // Deterministic phyllotaxis seed: evenly spread, never coincident.
  const spread = Math.min(maxX - minX, maxY - minY) / 2
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const r = spread * Math.sqrt((i + 0.5) / n)
    const a = i * GOLDEN_ANGLE
    xs[i] = cx + r * Math.cos(a)
    ys[i] = cy + r * Math.sin(a)
  }

  const index = new Map(nodes.map((node, i) => [node.id, i]))
  const links = validEdges(nodes, edges).map((e) => [index.get(e.source)!, index.get(e.target)!] as const)

  const iterations = options.iterations ?? defaultIterations(n)
  const dx = new Float64Array(n)
  const dy = new Float64Array(n)
  let temperature = Math.min(maxX - minX, maxY - minY) / 8
  const cooling = iterations > 0 ? temperature / (iterations + 1) : 0
  const k2 = k * k

  for (let it = 0; it < iterations; it++) {
    dx.fill(0)
    dy.fill(0)
    // Repulsion between every pair.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ddx = xs[i]! - xs[j]!
        let ddy = ys[i]! - ys[j]!
        let dist2 = ddx * ddx + ddy * ddy
        if (dist2 < 1e-6) {
          // Coincident: deterministic nudge based on indices.
          const a = (i * 7 + j * 13) % 360
          ddx = Math.cos(a) * 0.01
          ddy = Math.sin(a) * 0.01
          dist2 = 1e-4
        }
        const f = k2 / dist2 // (k²/d) * (1/d) to normalise the direction vector
        dx[i]! += ddx * f
        dy[i]! += ddy * f
        dx[j]! -= ddx * f
        dy[j]! -= ddy * f
      }
    }
    // Attraction along edges.
    for (const [a, b] of links) {
      const ddx = xs[a]! - xs[b]!
      const ddy = ys[a]! - ys[b]!
      const dist = Math.sqrt(ddx * ddx + ddy * ddy) || 0.01
      const f = dist / k // (d²/k) * (1/d)
      dx[a]! -= ddx * f
      dy[a]! -= ddy * f
      dx[b]! += ddx * f
      dy[b]! += ddy * f
    }
    // Gravity + temperature-limited displacement + clamping.
    for (let i = 0; i < n; i++) {
      dx[i]! += (cx - xs[i]!) * gravity
      dy[i]! += (cy - ys[i]!) * gravity
      const len = Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!)
      if (len > 0) {
        const step = Math.min(len, temperature)
        xs[i] = xs[i]! + (dx[i]! / len) * step
        ys[i] = ys[i]! + (dy[i]! / len) * step
      }
      xs[i] = Math.min(maxX, Math.max(minX, xs[i]!))
      ys[i] = Math.min(maxY, Math.max(minY, ys[i]!))
    }
    temperature = Math.max(temperature - cooling, 0.5)
  }

  nodes.forEach((node, i) => {
    result.set(node.id, { x: round2(xs[i]!), y: round2(ys[i]!) })
  })
  return result
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}
