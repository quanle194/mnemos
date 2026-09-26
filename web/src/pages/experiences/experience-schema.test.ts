import { describe, expect, it } from 'vitest'
import { EXPERIENCE_DEFAULTS, experienceSchema, toExperienceIn } from './experience-schema'

function issues(input: unknown): Record<string, string> {
  const r = experienceSchema.safeParse(input)
  if (r.success) return {}
  return Object.fromEntries(r.error.issues.map((i) => [i.path.join('.'), i.message]))
}

describe('experienceSchema', () => {
  it('accepts a complete experience and trims text', () => {
    const r = experienceSchema.parse({
      ...EXPERIENCE_DEFAULTS,
      task: '  deploy the api  ',
      outcome: 'failure',
    })
    expect(r.task).toBe('deploy the api')
    expect(r.outcome).toBe('failure')
  })

  it('requires a task (whitespace does not count)', () => {
    expect(issues({ ...EXPERIENCE_DEFAULTS, task: '   ' })).toEqual({ task: 'Task is required' })
  })

  it('bounds importance/confidence to 0..1 and rejects NaN from empty number inputs', () => {
    expect(issues({ ...EXPERIENCE_DEFAULTS, task: 't', importance: 1.2, confidence: -0.1 })).toEqual({
      importance: 'Importance must be ≤ 1',
      confidence: 'Confidence must be ≥ 0',
    })
    expect(issues({ ...EXPERIENCE_DEFAULTS, task: 't', importance: Number.NaN })).toEqual({
      importance: 'Importance must be a number between 0 and 1',
    })
  })

  it('only allows contract enums for outcome and source', () => {
    const r = issues({ ...EXPERIENCE_DEFAULTS, task: 't', outcome: 'great', source: 'rumour' })
    expect(Object.keys(r).sort()).toEqual(['outcome', 'source'])
  })

  it('enforces API length limits', () => {
    expect(issues({ ...EXPERIENCE_DEFAULTS, task: 't', result: 'x'.repeat(20001) })).toEqual({
      result: 'Result is at most 20000 characters',
    })
    expect(issues({ ...EXPERIENCE_DEFAULTS, task: 't', agent_name: 'a'.repeat(201) })).toEqual({
      agent_name: 'Agent name is at most 200 characters',
    })
  })

  it('maps to the ExperienceIn payload with nulls for empty optional names', () => {
    const body = toExperienceIn('ws-1', { ...EXPERIENCE_DEFAULTS, task: 't', project_name: 'web' })
    expect(body).toEqual({
      workspace_id: 'ws-1',
      task: 't',
      observation: '',
      action: '',
      result: '',
      outcome: 'success',
      importance: 0.5,
      confidence: 0.7,
      source: 'agent',
      project_name: 'web',
      agent_name: null,
      task_id: null,
    })
  })
})
