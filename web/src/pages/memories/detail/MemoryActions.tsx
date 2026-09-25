import { Archive, ArrowUpCircle, Check, Pencil, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ApiError, errorMessage } from '@/api/client'
import { useArchiveMemory, useMemory, usePromoteMemory, useReviewMemory } from '@/api/hooks/memories'
import type { Memory } from '@/api/types'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { EditMemoryDialog } from './EditMemoryDialog'

export interface MemoryCapabilities {
  canModify: boolean
  canReview: boolean
}

type Open = null | 'edit' | 'archive' | 'approve' | 'reject' | 'promote'

function useConflictAwareError(memoryId: string) {
  const detail = useMemory(memoryId)
  return (err: unknown) => {
    if (err instanceof ApiError && err.status === 409) {
      const cur = err.currentVersion
      toast.error(
        cur !== null
          ? `Conflict: the memory is now at version ${cur}. Reload and try again.`
          : `Conflict: ${err.message}`,
        { action: { label: 'Reload', onClick: () => void detail.refetch() } },
      )
      return
    }
    toast.error(errorMessage(err))
  }
}

export function MemoryActions({ memory, caps }: { memory: Memory; caps: MemoryCapabilities }) {
  const [open, setOpen] = useState<Open>(null)
  const [note, setNote] = useState('')
  const [promoteScope, setPromoteScope] = useState<'workspace' | 'organization'>('workspace')
  const archive = useArchiveMemory(memory.id)
  const review = useReviewMemory(memory.id)
  const promote = usePromoteMemory(memory.id)
  const onError = useConflictAwareError(memory.id)

  const close = () => {
    setOpen(null)
    setNote('')
  }
  const terminal = memory.status === 'archived' || memory.status === 'rejected'
  const reviewable = caps.canReview && memory.status === 'candidate' && memory.review_state === 'pending'
  const promotable = caps.canReview && memory.status === 'active' && memory.layer !== 4

  const doReview = (approve: boolean) =>
    review.mutate(
      { approve, note: note.trim(), expected_version: memory.version },
      {
        onSuccess: (m) => {
          toast.success(approve ? `Approved — memory is now ${m.status}` : 'Rejected candidate')
          close()
        },
        onError,
      },
    )

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="memory-actions">
      {reviewable ? (
        <>
          <Button size="sm" onClick={() => setOpen('approve')} data-testid="memory-approve-button">
            <Check /> Approve
          </Button>
          <Button size="sm" variant="outline" onClick={() => setOpen('reject')} data-testid="memory-reject-button">
            <X /> Reject
          </Button>
        </>
      ) : null}
      {promotable ? (
        <Button size="sm" variant="secondary" onClick={() => setOpen('promote')} data-testid="memory-promote-button">
          <ArrowUpCircle /> Promote to L4
        </Button>
      ) : null}
      {caps.canModify ? (
        <Button size="sm" variant="outline" onClick={() => setOpen('edit')} data-testid="memory-edit-button">
          <Pencil /> Edit
        </Button>
      ) : null}
      {caps.canModify && !terminal ? (
        <Button size="sm" variant="outline" onClick={() => setOpen('archive')} data-testid="memory-archive-button">
          <Archive /> {memory.status === 'candidate' ? 'Reject / archive' : 'Archive'}
        </Button>
      ) : null}

      {open === 'edit' ? <EditMemoryDialog memory={memory} onClose={close} /> : null}

      <ConfirmDialog
        open={open === 'archive'}
        onOpenChange={(o) => !o && close()}
        title={memory.status === 'candidate' ? 'Reject candidate?' : 'Archive memory?'}
        description="Archiving removes it from normal retrieval. Evidence and history are preserved (no hard delete)."
        confirmLabel={memory.status === 'candidate' ? 'Reject' : 'Archive'}
        destructive
        pending={archive.isPending}
        data-testid="memory-archive-dialog"
        onConfirm={() =>
          archive.mutate(
            { version: memory.version, reason: note.trim() || 'archived via dashboard' },
            {
              onSuccess: (m) => {
                toast.success(`Memory ${m.status}`)
                close()
              },
              onError,
            },
          )
        }
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="archive-reason">Reason</Label>
          <Input
            id="archive-reason"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="archived via dashboard"
            data-testid="memory-archive-reason"
          />
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={open === 'approve' || open === 'reject'}
        onOpenChange={(o) => !o && close()}
        title={open === 'approve' ? 'Approve candidate' : 'Reject candidate'}
        description={
          open === 'approve'
            ? 'Approval adds reviewer evidence and promotes the candidate to active knowledge.'
            : 'The candidate becomes rejected and will not be retrieved.'
        }
        confirmLabel={open === 'approve' ? 'Approve' : 'Reject'}
        destructive={open === 'reject'}
        pending={review.isPending}
        data-testid="memory-review-dialog"
        onConfirm={() => doReview(open === 'approve')}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="review-note">Review note</Label>
          <Textarea
            id="review-note"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid="memory-review-note"
          />
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={open === 'promote'}
        onOpenChange={(o) => !o && close()}
        title="Promote to L4 organizational memory"
        description="L4 memories are trusted shared knowledge. This is audited and requires review permission."
        confirmLabel="Promote"
        pending={promote.isPending}
        data-testid="memory-promote-dialog"
        onConfirm={() =>
          promote.mutate(
            { scope_type: promoteScope, expected_version: memory.version, note: note.trim() },
            {
              onSuccess: () => {
                toast.success(`Promoted to L4 (${promoteScope})`)
                close()
              },
              onError,
            },
          )
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promote-scope">Share with</Label>
            <NativeSelect
              id="promote-scope"
              value={promoteScope}
              onChange={(e) => setPromoteScope(e.target.value as 'workspace' | 'organization')}
              data-testid="memory-promote-scope"
            >
              <option value="workspace">Whole workspace</option>
              <option value="organization">Whole organization</option>
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="promote-note">Note</Label>
            <Input id="promote-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
      </ConfirmDialog>
    </div>
  )
}
