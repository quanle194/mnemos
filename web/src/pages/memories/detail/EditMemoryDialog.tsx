import { zodResolver } from '@hookform/resolvers/zod'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { ApiError, errorMessage } from '@/api/client'
import { useMemory, usePatchMemory } from '@/api/hooks/memories'
import type { Memory } from '@/api/types'
import { Field } from '@/components/common/Field'
import { describedBy } from '@/lib/a11y'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Textarea } from '@/components/ui/textarea'
import { buildPatch, editMemorySchema, memoryToEditForm as fromMemory, type EditMemoryForm } from '../memory-schemas'

interface Conflict {
  attempted: number
  current: number | null
}

interface Props {
  memory: Memory
  onClose: () => void
}

/** Mounted fresh on every open, so the edited base version is fixed at open time (optimistic concurrency). */
export function EditMemoryDialog({ memory, onClose }: Props) {
  const detail = useMemory(memory.id)
  const patch = usePatchMemory(memory.id)
  const [base, setBase] = useState(() => ({ version: memory.version, values: fromMemory(memory) }))
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [reloading, setReloading] = useState(false)
  const form = useForm<EditMemoryForm>({ resolver: zodResolver(editMemorySchema), defaultValues: base.values })
  const { errors, isSubmitting } = form.formState

  const onSubmit = form.handleSubmit(async (values) => {
    const body = buildPatch(base.values, values)
    if (Object.keys(body).length === 0) {
      form.setError('root', { message: 'No changes to save.' })
      return
    }
    body.reason = values.reason || 'edited via dashboard'
    try {
      const updated = await patch.mutateAsync({ version: base.version, patch: body })
      toast.success(`Saved as version ${updated.version}`)
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflict({ attempted: base.version, current: err.currentVersion })
        toast.error('Edit conflict: the memory changed since you opened it.')
      }
    }
  })

  const reloadLatest = async () => {
    setReloading(true)
    try {
      const res = await detail.refetch()
      if (res.data) {
        const values = fromMemory(res.data)
        setBase({ version: res.data.version, values })
        form.reset(values)
        setConflict(null)
        patch.reset()
      }
    } finally {
      setReloading(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit memory</DialogTitle>
          <DialogDescription>
            Editing version <strong data-testid="memory-edit-base-version">{base.version}</strong>. Saving creates a new
            version (If-Match: &quot;{base.version}&quot;); history is preserved.
          </DialogDescription>
        </DialogHeader>
        {conflict ? (
          <Alert variant="warning" data-testid="memory-conflict-alert">
            <AlertTriangle />
            <AlertTitle>Version conflict</AlertTitle>
            <AlertDescription>
              <p>
                Someone else changed this memory
                {conflict.current !== null ? (
                  <>
                    {' '}
                    — it is now at <strong>version {conflict.current}</strong>
                  </>
                ) : null}
                , but you edited version {conflict.attempted}. Your changes were not saved.
              </p>
              <p>Reload the latest version, then re-apply your edits.</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-1"
                onClick={() => void reloadLatest()}
                disabled={reloading}
                data-testid="memory-conflict-reload"
              >
                <RefreshCw /> {reloading ? 'Reloading…' : 'Reload latest version'}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        <form className="grid gap-4 sm:grid-cols-2" onSubmit={onSubmit} noValidate data-testid="memory-edit-form">
          <Field id="me-title" label="Title" error={errors.title?.message} className="sm:col-span-2">
            <Input
              id="me-title"
              aria-invalid={Boolean(errors.title)}
              aria-describedby={describedBy('me-title', errors.title?.message)}
              data-testid="memory-edit-title"
              {...form.register('title')}
            />
          </Field>
          <Field id="me-content" label="Content" error={errors.content?.message} className="sm:col-span-2">
            <Textarea
              id="me-content"
              rows={6}
              aria-invalid={Boolean(errors.content)}
              data-testid="memory-edit-content"
              {...form.register('content')}
            />
          </Field>
          <Field id="me-importance" label="Importance (0–1)" error={errors.importance?.message}>
            <Input
              id="me-importance"
              type="number"
              step="0.05"
              min={0}
              max={1}
              aria-invalid={Boolean(errors.importance)}
              data-testid="memory-edit-importance"
              {...form.register('importance', { valueAsNumber: true })}
            />
          </Field>
          <Field id="me-confidence" label="Confidence (0–1)" error={errors.confidence?.message}>
            <Input
              id="me-confidence"
              type="number"
              step="0.05"
              min={0}
              max={1}
              aria-invalid={Boolean(errors.confidence)}
              data-testid="memory-edit-confidence"
              {...form.register('confidence', { valueAsNumber: true })}
            />
          </Field>
          <Field
            id="me-valid-until"
            label="Valid until"
            error={errors.valid_until?.message}
            hint="Clear to make it valid indefinitely"
          >
            <Input
              id="me-valid-until"
              type="datetime-local"
              data-testid="memory-edit-valid-until"
              {...form.register('valid_until')}
            />
          </Field>
          <Field id="me-reason" label="Change reason" error={errors.reason?.message}>
            <Input
              id="me-reason"
              placeholder="edited via dashboard"
              data-testid="memory-edit-reason"
              {...form.register('reason')}
            />
          </Field>
          {errors.root?.message ? (
            <p className="text-sm text-destructive sm:col-span-2" role="alert">
              {errors.root.message}
            </p>
          ) : null}
          {patch.isError && !conflict ? (
            <Alert variant="destructive" className="sm:col-span-2" data-testid="memory-edit-error">
              <AlertDescription>{errorMessage(patch.error)}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter className="sm:col-span-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || Boolean(conflict)} data-testid="memory-edit-submit">
              {isSubmitting ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
