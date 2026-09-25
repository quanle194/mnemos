import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useCreateMemory } from '@/api/hooks/memories'
import { useAgents, useProjects } from '@/api/hooks/tenancy'
import { MEMORY_TYPES } from '@/api/types'
import { usePermissions } from '@/auth/permissions'
import { useWorkspaceId } from '@/auth/session-context'
import { Field } from '@/components/common/Field'
import { describedBy } from '@/lib/a11y'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { humanize } from '@/lib/format'
import { proposeMemorySchema, toMemoryIn, type ProposeMemoryForm } from './memory-schemas'

const DEFAULTS: ProposeMemoryForm = {
  title: '',
  content: '',
  type: 'fact',
  scope_type: 'workspace',
  project_name: '',
  agent_name: '',
  confidence: 0.6,
  importance: 0.5,
  layer: '3',
  status: 'candidate',
  valid_until: '',
}

export function ProposeMemoryDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const ws = useWorkspaceId()
  const navigate = useNavigate()
  const { can } = usePermissions()
  const canReview = can('memory:review')
  const create = useCreateMemory()
  const projects = useProjects(open ? ws : null)
  const agents = useAgents(open ? ws : null)
  const form = useForm<ProposeMemoryForm>({
    resolver: zodResolver(proposeMemorySchema),
    defaultValues: DEFAULTS,
  })
  const { errors, isSubmitting } = form.formState
  const scope = form.watch('scope_type')

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const m = await create.mutateAsync(toMemoryIn(ws, values))
      toast.success(m.status === 'active' ? 'Memory created as active' : 'Memory proposed as candidate')
      form.reset(DEFAULTS)
      onOpenChange(false)
      void navigate(`/memories/${m.id}`)
    } catch {
      // surfaced below via create.error
    }
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) create.reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Propose memory</DialogTitle>
          <DialogDescription>
            New memories start as <strong>candidates</strong> and go through validation. Only reviewers can
            create active, L4 or organization-scoped memories.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={onSubmit}
          noValidate
          data-testid="propose-memory-form"
        >
          <Field id="pm-title" label="Title" error={errors.title?.message} className="sm:col-span-2">
            <Input
              id="pm-title"
              aria-invalid={Boolean(errors.title)}
              aria-describedby={describedBy('pm-title', errors.title?.message)}
              data-testid="propose-memory-title"
              {...form.register('title')}
            />
          </Field>
          <Field id="pm-content" label="Content" error={errors.content?.message} className="sm:col-span-2">
            <Textarea
              id="pm-content"
              rows={5}
              aria-invalid={Boolean(errors.content)}
              aria-describedby={describedBy('pm-content', errors.content?.message)}
              data-testid="propose-memory-content"
              {...form.register('content')}
            />
          </Field>
          <Field id="pm-type" label="Type" error={errors.type?.message}>
            <NativeSelect id="pm-type" data-testid="propose-memory-type" {...form.register('type')}>
              {MEMORY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {humanize(t)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field id="pm-scope" label="Scope" error={errors.scope_type?.message}>
            <NativeSelect id="pm-scope" data-testid="propose-memory-scope" {...form.register('scope_type')}>
              <option value="workspace">Workspace</option>
              <option value="project">Project</option>
              <option value="agent">Agent</option>
              <option value="organization" disabled={!canReview}>
                Organization{canReview ? '' : ' (reviewers only)'}
              </option>
            </NativeSelect>
          </Field>
          {scope === 'project' ? (
            <Field
              id="pm-project"
              label="Project name"
              error={errors.project_name?.message}
              hint="Existing project, or a new one is created"
            >
              <Input
                id="pm-project"
                list="pm-project-options"
                aria-invalid={Boolean(errors.project_name)}
                data-testid="propose-memory-project"
                {...form.register('project_name')}
              />
              <datalist id="pm-project-options">
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.name} />
                ))}
              </datalist>
            </Field>
          ) : null}
          {scope === 'agent' ? (
            <Field id="pm-agent" label="Agent name" error={errors.agent_name?.message}>
              <Input
                id="pm-agent"
                list="pm-agent-options"
                aria-invalid={Boolean(errors.agent_name)}
                data-testid="propose-memory-agent"
                {...form.register('agent_name')}
              />
              <datalist id="pm-agent-options">
                {(agents.data ?? []).map((a) => (
                  <option key={a.id} value={a.name} />
                ))}
              </datalist>
            </Field>
          ) : null}
          <Field id="pm-confidence" label="Confidence (0–1)" error={errors.confidence?.message}>
            <Input
              id="pm-confidence"
              type="number"
              step="0.05"
              min={0}
              max={1}
              aria-invalid={Boolean(errors.confidence)}
              data-testid="propose-memory-confidence"
              {...form.register('confidence', { valueAsNumber: true })}
            />
          </Field>
          <Field id="pm-importance" label="Importance (0–1)" error={errors.importance?.message}>
            <Input
              id="pm-importance"
              type="number"
              step="0.05"
              min={0}
              max={1}
              aria-invalid={Boolean(errors.importance)}
              data-testid="propose-memory-importance"
              {...form.register('importance', { valueAsNumber: true })}
            />
          </Field>
          <Field id="pm-layer" label="Layer">
            <NativeSelect id="pm-layer" data-testid="propose-memory-layer" {...form.register('layer')}>
              <option value="3">L3 semantic</option>
              <option value="4" disabled={!canReview}>
                L4 organizational{canReview ? '' : ' (reviewers only)'}
              </option>
            </NativeSelect>
          </Field>
          <Field id="pm-status" label="Initial status">
            <NativeSelect id="pm-status" data-testid="propose-memory-status" {...form.register('status')}>
              <option value="candidate">Candidate (validated by workers)</option>
              <option value="active" disabled={!canReview}>
                Active{canReview ? ' (reviewer)' : ' (reviewers only)'}
              </option>
            </NativeSelect>
          </Field>
          <Field id="pm-valid-until" label="Valid until (optional)" error={errors.valid_until?.message}>
            <Input
              id="pm-valid-until"
              type="datetime-local"
              data-testid="propose-memory-valid-until"
              {...form.register('valid_until')}
            />
          </Field>
          {create.isError ? (
            <Alert variant="destructive" className="sm:col-span-2" data-testid="propose-memory-error">
              <AlertDescription>{errorMessage(create.error)}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter className="sm:col-span-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting} data-testid="propose-memory-submit">
              {isSubmitting ? 'Submitting…' : 'Propose'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
