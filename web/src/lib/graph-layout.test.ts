import { describe, expect, it } from 'vitest'
import { computeForceLayout, defaultIterations, distance, validEdges, type LayoutEdge } from './graph-layout'

const opts = { width: 800, height: 600, padding: 20 }
const nodes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}` }))

describe('computeForceLayout', () => {
  it('handles empty and single-node graphs', () => {
    expect(computeForceLayout([], [], opts).size).toBe(0)
    const one = computeForceLayout([{ id: 'a' }], [], opts)
    expect(one.get('a')).toEqual({ x: 400, y: 300 })
  })

  it('is deterministic for identical input', () => {
    const ns = nodes(25)
    const es: LayoutEdge[] = ns.slice(1).map((n, i) => ({ source: `n${i}`, target: n.id }))
    const a = computeForceLayout(ns, es, opts)
    const b = computeForceLayout(ns, es, opts)
    expect([...a.entries()]).toEqual([...b.entries()])
  })

  it('keeps every node inside the padded canvas and produces finite coordinates', () => {
    const ns = nodes(60)
    const es: LayoutEdge[] = ns.map((n, i) => ({ source: n.id, target: `n${(i * 7) % 60}` }))
    const pos = computeForceLayout(ns, es, opts)
    expect(pos.size).toBe(60)
    for (const p of pos.values()) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
      expect(p.x).toBeGreaterThanOrEqual(20)
      expect(p.x).toBeLessThanOrEqual(780)
      expect(p.y).toBeGreaterThanOrEqual(20)
      expect(p.y).toBeLessThanOrEqual(580)
    }
  })

  it('pulls connected nodes closer together than unconnected ones', () => {
    // Two 4-cliques joined by nothing: intra-cluster distances should be smaller than inter-cluster ones.
    const ns = nodes(8)
    const clique = (ids: number[]) =>
      ids.flatMap((a, i) => ids.slice(i + 1).map((b) => ({ source: `n${a}`, target: `n${b}` })))
    const es = [...clique([0, 2, 4, 6]), ...clique([1, 3, 5, 7])]
    const pos = computeForceLayout(ns, es, { ...opts, iterations: 300 })
    const d = (a: number, b: number) => distance(pos.get(`n${a}`)!, pos.get(`n${b}`)!)
    const intra = [d(0, 2), d(0, 4), d(2, 6), d(1, 3), d(3, 7), d(5, 7)]
    const inter = [d(0, 1), d(2, 3), d(4, 5), d(6, 7), d(0, 7), d(2, 5)]
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
    expect(avg(intra)).toBeLessThan(avg(inter))
  })

  it('separates nodes (no two nodes collapse onto the same point)', () => {
    const ns = nodes(30)
    const pos = [...computeForceLayout(ns, [], opts).values()]
    let min = Infinity
    for (let i = 0; i < pos.length; i++)
      for (let j = i + 1; j < pos.length; j++) min = Math.min(min, distance(pos[i]!, pos[j]!))
    expect(min).toBeGreaterThan(5)
  })

  it('ignores dangling edges, self-loops and duplicates', () => {
    const ns = nodes(3)
    const es: LayoutEdge[] = [
      { source: 'n0', target: 'n1' },
      { source: 'n1', target: 'n0' },
      { source: 'n2', target: 'n2' },
      { source: 'n0', target: 'missing' },
    ]
    expect(validEdges(ns, es)).toEqual([{ source: 'n0', target: 'n1' }])
    const pos = computeForceLayout(ns, es, opts)
    expect(pos.size).toBe(3)
  })

  it('bounds iteration work as graphs grow', () => {
    expect(defaultIterations(1)).toBe(0)
    expect(defaultIterations(10)).toBe(300)
    expect(defaultIterations(300)).toBeLessThan(300)
    expect(defaultIterations(10_000)).toBe(60)
  })
})
