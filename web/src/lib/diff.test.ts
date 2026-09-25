import { describe, expect, it } from 'vitest'
import { diffSnapshots, displayValue } from './diff'

describe('diffSnapshots', () => {
  it('returns nothing for the first version', () => {
    expect(diffSnapshots(null, { title: 'a' })).toEqual([])
  })

  it('reports changed, added and removed keys sorted, ignoring noisy fields', () => {
    const prev = { title: 'a', status: 'candidate', confidence: 0.6, updated_at: 't1', tags: ['x'] }
    const next = {
      title: 'b',
      status: 'candidate',
      confidence: 0.7,
      updated_at: 't2',
      tags: ['x'],
      valid_until: 'z',
    }
    expect(diffSnapshots(prev, next)).toEqual([
      { key: 'confidence', before: 0.6, after: 0.7 },
      { key: 'title', before: 'a', after: 'b' },
      { key: 'valid_until', before: undefined, after: 'z' },
    ])
  })

  it('compares nested values structurally', () => {
    expect(diffSnapshots({ m: { a: 1 } }, { m: { a: 1 } })).toEqual([])
    expect(diffSnapshots({ m: { a: 1 } }, { m: { a: 2 } })).toHaveLength(1)
  })

  it('renders values compactly', () => {
    expect(displayValue(undefined)).toBe('∅')
    expect(displayValue(null)).toBe('null')
    expect(displayValue({ a: 1 })).toBe('{"a":1}')
    expect(displayValue('x'.repeat(300), 10)).toHaveLength(10)
  })
})
