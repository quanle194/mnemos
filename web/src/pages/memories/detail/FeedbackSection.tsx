import { MessageSquarePlus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useMemoryFeedback, useSubmitFeedback } from '@/api/hooks/memories'
import { FEEDBACK_VALUES, type FeedbackValue } from '@/api/types'
import { IdText } from '@/components/common/IdText'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { StatusBadge } from '@/components/common/StatusBadge'
import { TimeAgo } from '@/components/common/TimeAgo'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { formatScore, humanize } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Section } from './Section'

const HINTS: Record<FeedbackValue, string> = {
  helpful: 'Raises utility and trust',
  irrelevant: 'Lowers utility for ranking',
  incorrect: 'Lowers trust; repeated reports dispute it',
  outdated: 'Repeated reports expire it',
  harmful: 'Quarantines (disputes) the memory',
}

function FeedbackForm({ memoryId }: { memoryId: string }) {
  const [value, setValue] = useState<FeedbackValue | null>(null)
  const [note, setNote] = useState('')
  const submit = useSubmitFeedback(memoryId)

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3"
      data-testid="feedback-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!value) return
        submit.mutate(
          { value, note: note.trim() },
          {
            onSuccess: (res) => {
              const m = res.memory
              const utility =
                typeof m.utility_score === 'number' ? ` · utility ${formatScore(m.utility_score)}` : ''
              const action = typeof m.lifecycle_action === 'string' ? ` · memory ${m.lifecycle_action}` : ''
              toast.success(`Feedback recorded: ${value}${utility}${action}`)
              setValue(null)
              setNote('')
            },
          },
        )
      }}
    >
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Was this memory useful?</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Feedback value">
          {FEEDBACK_VALUES.map((v) => (
            <label
              key={v}
              className={cn(
                'inline-flex cursor-pointer items-center rounded-md border px-3 py-1.5 text-sm capitalize transition-colors hover:bg-accent has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
                value === v && 'border-primary bg-primary/10 text-primary',
              )}
              title={HINTS[v]}
              data-testid={`feedback-value-${v}`}
            >
              <input
                type="radio"
                name="feedback-value"
                value={v}
                checked={value === v}
                onChange={() => setValue(v)}
                className="sr-only"
              />
              {humanize(v)}
            </label>
          ))}
        </div>
        {value ? <p className="text-xs text-muted-foreground">{HINTS[value]}</p> : null}
      </fieldset>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="feedback-note">Note (optional)</Label>
        <Textarea
          id="feedback-note"
          rows={2}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          data-testid="feedback-note"
        />
      </div>
      {submit.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(submit.error)}</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <Button type="submit" size="sm" disabled={!value || submit.isPending} data-testid="feedback-submit">
          <MessageSquarePlus /> {submit.isPending ? 'Sending…' : 'Submit feedback'}
        </Button>
      </div>
    </form>
  )
}

export function FeedbackSection({ memoryId, canWrite }: { memoryId: string; canWrite: boolean }) {
  const q = useMemoryFeedback(memoryId)
  return (
    <Section
      title="Feedback"
      description="Feedback adjusts utility/trust and lifecycle — it never rewrites the memory content."
      count={q.data?.length}
      testId="memory-feedback"
    >
      <div className="flex flex-col gap-4">
        {canWrite ? <FeedbackForm memoryId={memoryId} /> : null}
        {q.isPending ? (
          <LoadingState rows={2} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data.length === 0 ? (
          <EmptyState title="No feedback yet" />
        ) : (
          <ul className="flex flex-col divide-y" data-testid="feedback-list">
            {q.data.map((f) => (
              <li
                key={f.id}
                className="flex flex-col gap-1 py-2 text-sm first:pt-0 last:pb-0"
                data-testid="feedback-row"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge kind="feedback" value={f.value} />
                  {f.agent_id ? (
                    <span className="text-xs text-muted-foreground">
                      agent <IdText id={f.agent_id} />
                    </span>
                  ) : null}
                  {f.task_id ? <span className="text-xs text-muted-foreground">task {f.task_id}</span> : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    <TimeAgo iso={f.created_at} />
                  </span>
                </div>
                {f.note ? <p className="text-muted-foreground">{f.note}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}
