import { describe, expect, it } from 'vitest'
import { classifyMetrics, formatMetricValue } from './metrics'

describe('classifyMetrics', () => {
  it('labels grouped measured/estimated sections', () => {
    const m = classifyMetrics({
      measured: { task_success_rate: 0.9, repeated_error_rate: 0.05 },
      estimated: { tokens_saved: 1200 },
    })
    expect(m).toEqual([
      { key: 'task_success_rate', value: 0.9, kind: 'measured' },
      { key: 'repeated_error_rate', value: 0.05, kind: 'measured' },
      { key: 'tokens_saved', value: 1200, kind: 'estimated' },
    ])
  })

  it('labels per-metric {value, kind} objects and key-name conventions', () => {
    const m = classifyMetrics({
      recall: { value: 0.8, kind: 'measured' },
      cost: { value: 3.2, estimated: true },
      tool_calls_estimate: 4,
      latency_ms_measured: 12,
      runs: 10,
    })
    expect(m).toEqual([
      { key: 'recall', value: 0.8, kind: 'measured' },
      { key: 'cost', value: 3.2, kind: 'estimated' },
      { key: 'tool_calls_estimate', value: 4, kind: 'estimated' },
      { key: 'latency_ms_measured', value: 12, kind: 'measured' },
      { key: 'runs', value: 10, kind: 'unlabelled' },
    ])
  })

  it('flattens nested groups with dotted keys and inherits labels', () => {
    const m = classifyMetrics({ baseline: { measured: { success: 0.4 } }, with_memory: { success: 0.9 } })
    expect(m).toEqual([
      { key: 'baseline.success', value: 0.4, kind: 'measured' },
      { key: 'with_memory.success', value: 0.9, kind: 'unlabelled' },
    ])
    expect(classifyMetrics(null)).toEqual([])
  })

  it('formats values', () => {
    expect(formatMetricValue(3)).toBe('3')
    expect(formatMetricValue(0.12345)).toBe('0.123')
    expect(formatMetricValue(12.345)).toBe('12.35')
    expect(formatMetricValue(true)).toBe('true')
    expect(formatMetricValue(null)).toBe('—')
    expect(formatMetricValue([1])).toBe('[1]')
  })
})
