import { z } from 'zod'
import { MEMORY_TYPES, type Memory, type MemoryIn, type MemoryPatch } from '@/api/types'
import { isoToLocalInput, localInputToIso } from '@/lib/format'

const score = (label: string) =>
  z
    .number({ error: `${label} must be a number between 0 and 1` })
    .min(0, `${label} must be ≥ 0`)
    .max(1, `${label} must be ≤ 1`)

export const proposeMemorySchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(300, 'Title is at most 300 characters'),
    content: z.string().trim().min(1, 'Content is required').max(20000, 'Content is at most 20000 characters'),
    type: z.enum(MEMORY_TYPES),
    scope_type: z.enum(['workspace', 'project', 'agent', 'organization']),
    project_name: z.string().trim().max(200),
    agent_name: z.string().trim().max(200),
    confidence: score('Confidence'),
    importance: score('Importance'),
    layer: z.enum(['3', '4']),
    status: z.enum(['candidate', 'active']),
    valid_until: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.scope_type === 'project' && !v.project_name) {
      ctx.addIssue({ code: 'custom', path: ['project_name'], message: 'Project scope needs a project name' })
    }
    if (v.scope_type === 'agent' && !v.agent_name) {
      ctx.addIssue({ code: 'custom', path: ['agent_name'], message: 'Agent scope needs an agent name' })
    }
    if (v.valid_until && Number.isNaN(new Date(v.valid_until).getTime())) {
      ctx.addIssue({ code: 'custom', path: ['valid_until'], message: 'Invalid date' })
    }
  })

export type ProposeMemoryForm = z.infer<typeof proposeMemorySchema>

export const editMemorySchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(300, 'Title is at most 300 characters'),
  content: z.string().trim().min(1, 'Content is required').max(20000, 'Content is at most 20000 characters'),
  importance: score('Importance'),
  confidence: score('Confidence'),
  valid_until: z.string().refine((v) => !v || !Number.isNaN(new Date(v).getTime()), 'Invalid date'),
  reason: z.string().trim().max(500, 'Reason is at most 500 characters'),
})

export type EditMemoryForm = z.infer<typeof editMemorySchema>

export function toMemoryIn(ws: string, v: ProposeMemoryForm): MemoryIn {
  return {
    workspace_id: ws,
    title: v.title,
    content: v.content,
    type: v.type,
    scope_type: v.scope_type,
    project_name: v.project_name || null,
    agent_name: v.agent_name || null,
    confidence: v.confidence,
    importance: v.importance,
    layer: v.layer === '4' ? 4 : 3,
    status: v.status,
    valid_until: localInputToIso(v.valid_until),
  }
}

export function memoryToEditForm(m: Memory): EditMemoryForm {
  return {
    title: m.title,
    content: m.content,
    importance: m.importance,
    confidence: m.confidence,
    valid_until: isoToLocalInput(m.valid_until),
    reason: '',
  }
}

/** Only send fields that changed relative to the version the user started editing. */
export function buildPatch(base: EditMemoryForm, v: EditMemoryForm): MemoryPatch {
  const patch: MemoryPatch = {}
  if (v.title !== base.title) patch.title = v.title
  if (v.content !== base.content) patch.content = v.content
  if (v.importance !== base.importance) patch.importance = v.importance
  if (v.confidence !== base.confidence) patch.confidence = v.confidence
  if (v.valid_until !== base.valid_until) patch.valid_until = localInputToIso(v.valid_until)
  return patch
}
