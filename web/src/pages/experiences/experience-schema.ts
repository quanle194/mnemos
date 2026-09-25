import { z } from 'zod'
import { EXPERIENCE_SOURCES, OUTCOMES, type ExperienceIn } from '@/api/types'

const score = (label: string) =>
  z
    .number({ error: `${label} must be a number between 0 and 1` })
    .min(0, `${label} must be ≥ 0`)
    .max(1, `${label} must be ≤ 1`)

const longText = (label: string) => z.string().max(20000, `${label} is at most 20000 characters`)

export const experienceSchema = z.object({
  task: z.string().trim().min(1, 'Task is required').max(20000, 'Task is at most 20000 characters'),
  observation: longText('Observation'),
  action: longText('Action'),
  result: longText('Result'),
  outcome: z.enum(OUTCOMES, { error: 'Choose an outcome' }),
  importance: score('Importance'),
  confidence: score('Confidence'),
  source: z.enum(EXPERIENCE_SOURCES),
  project_name: z.string().trim().max(200, 'Project name is at most 200 characters'),
  agent_name: z.string().trim().max(200, 'Agent name is at most 200 characters'),
  task_id: z.string().trim().max(200, 'Task id is at most 200 characters'),
})

export type ExperienceForm = z.infer<typeof experienceSchema>

export const EXPERIENCE_DEFAULTS: ExperienceForm = {
  task: '',
  observation: '',
  action: '',
  result: '',
  outcome: 'success',
  importance: 0.5,
  confidence: 0.7,
  source: 'agent',
  project_name: '',
  agent_name: '',
  task_id: '',
}

export function toExperienceIn(ws: string, v: ExperienceForm): ExperienceIn {
  return {
    workspace_id: ws,
    task: v.task,
    observation: v.observation,
    action: v.action,
    result: v.result,
    outcome: v.outcome,
    importance: v.importance,
    confidence: v.confidence,
    source: v.source,
    project_name: v.project_name || null,
    agent_name: v.agent_name || null,
    task_id: v.task_id || null,
  }
}
