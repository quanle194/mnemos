import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useCreateExperience } from '@/api/hooks/experiences'
import { useAgents, useProjects } from '@/api/hooks/tenancy'
import { EXPERIENCE_SOURCES, OUTCOMES } from '@/api/types'
import { useWorkspaceId } from '@/auth/session-context'
import { Field } from '@/components/common/Field'
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
import { describedBy } from '@/lib/a11y'
import { humanize } from '@/lib/format'
import {
  EXPERIENCE_DEFAULTS,
  experienceSchema,
  toExperienceIn,
  type ExperienceForm,
} from './experience-schema'

export function ExperienceFormFields({ onDone }: { onDone?: () => void }) {
  const ws = useWorkspaceId()
  const navigate = useNavigate()
  const create = useCreateExperience()
  const projects = useProjects(ws)
  const agents = useAgents(ws)
  const form = useForm<ExperienceForm>({
    resolver: zodResolver(experienceSchema),
    defaultValues: EXPERIENCE_DEFAULTS,
  })
  const { errors, isSubmitting } = form.formState

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const res = await create.mutateAsync(toExperienceIn(ws, values))
      toast.success('Experience recorded — learning job queued')
      form.reset(EXPERIENCE_DEFAULTS)
      onDone?.()
      void navigate(`/experiences/${res.experience.id}`)
    } catch {
      // rendered from create.error
    }
  })

  const text = (
    name: 'task' | 'observation' | 'action' | 'result',
    label: string,
    rows: number,
    hint?: string,
  ) => (
    <Field
      id={`exp-${name}`}
      label={label}
      error={errors[name]?.message}
      hint={hint}
      className="sm:col-span-2"
    >
      <Textarea
        id={`exp-${name}`}
        rows={rows}
        aria-invalid={Boolean(errors[name])}
        aria-describedby={describedBy(`exp-${name}`, errors[name]?.message, Boolean(hint))}
        data-testid={`experience-${name}`}
        {...form.register(name)}
      />
    </Field>
  )

  return (
    <form className="grid gap-4 sm:grid-cols-2" onSubmit={onSubmit} noValidate data-testid="experience-form">
      {text('task', 'Task', 2, 'What the agent was trying to do')}
      {text('observation', 'Observation', 2)}
      {text('action', 'Action', 2)}
      {text('result', 'Result', 2)}
      <Field id="exp-outcome" label="Outcome" error={errors.outcome?.message}>
        <NativeSelect id="exp-outcome" data-testid="experience-outcome" {...form.register('outcome')}>
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {humanize(o)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field
        id="exp-source"
        label="Source"
        error={errors.source?.message}
        hint="External sources get lower trust"
      >
        <NativeSelect id="exp-source" data-testid="experience-source" {...form.register('source')}>
          {EXPERIENCE_SOURCES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="exp-importance" label="Importance (0–1)" error={errors.importance?.message}>
        <Input
          id="exp-importance"
          type="number"
          step="0.05"
          min={0}
          max={1}
          aria-invalid={Boolean(errors.importance)}
          aria-describedby={describedBy('exp-importance', errors.importance?.message)}
          data-testid="experience-importance"
          {...form.register('importance', { valueAsNumber: true })}
        />
      </Field>
      <Field id="exp-confidence" label="Confidence (0–1)" error={errors.confidence?.message}>
        <Input
          id="exp-confidence"
          type="number"
          step="0.05"
          min={0}
          max={1}
          aria-invalid={Boolean(errors.confidence)}
          aria-describedby={describedBy('exp-confidence', errors.confidence?.message)}
          data-testid="experience-confidence"
          {...form.register('confidence', { valueAsNumber: true })}
        />
      </Field>
      <Field id="exp-project" label="Project name" error={errors.project_name?.message} hint="Created if new">
        <Input
          id="exp-project"
          list="exp-project-options"
          data-testid="experience-project-name"
          {...form.register('project_name')}
        />
        <datalist id="exp-project-options">
          {(projects.data ?? []).map((p) => (
            <option key={p.id} value={p.name} />
          ))}
        </datalist>
      </Field>
      <Field id="exp-agent" label="Agent name" error={errors.agent_name?.message} hint="Created if new">
        <Input
          id="exp-agent"
          list="exp-agent-options"
          data-testid="experience-agent-name"
          {...form.register('agent_name')}
        />
        <datalist id="exp-agent-options">
          {(agents.data ?? []).map((a) => (
            <option key={a.id} value={a.name} />
          ))}
        </datalist>
      </Field>
      <Field id="exp-task-id" label="Task id (optional)" error={errors.task_id?.message}>
        <Input id="exp-task-id" data-testid="experience-task-id" {...form.register('task_id')} />
      </Field>
      {create.isError ? (
        <Alert variant="destructive" className="sm:col-span-2" data-testid="experience-error">
          <AlertDescription>{errorMessage(create.error)}</AlertDescription>
        </Alert>
      ) : null}
      <DialogFooter className="sm:col-span-2">
        <Button type="submit" disabled={isSubmitting} data-testid="experience-submit">
          {isSubmitting ? 'Recording…' : 'Record experience'}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function ExperienceFormDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record experience</DialogTitle>
          <DialogDescription>
            Experiences are evidence. Workers extract candidate memories from them asynchronously.
          </DialogDescription>
        </DialogHeader>
        {open ? <ExperienceFormFields onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  )
}
