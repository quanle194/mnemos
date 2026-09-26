import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useWorkspaces } from '@/api/hooks/tenancy'
import { NativeSelect } from '@/components/ui/native-select'
import { useSession } from '@/auth/session-context'

export function WorkspaceSwitcher({ className }: { className?: string }) {
  const { workspaceId, setWorkspace } = useSession()
  const { data: workspaces, isLoading } = useWorkspaces()
  const qc = useQueryClient()

  return (
    <div className={className}>
      <label htmlFor="workspace-switcher" className="sr-only">
        Active workspace
      </label>
      <NativeSelect
        id="workspace-switcher"
        data-testid="workspace-switcher"
        value={workspaceId ?? ''}
        disabled={isLoading || !workspaces?.length}
        onChange={(e) => {
          const id = e.target.value
          if (!id || id === workspaceId) return
          setWorkspace(id)
          // Workspace-scoped queries are keyed by id; drop open detail queries of the previous workspace.
          void qc.invalidateQueries()
          const ws = workspaces?.find((w) => w.id === id)
          toast.success(`Switched to workspace “${ws?.name ?? id}”`)
        }}
        className="w-44 sm:w-56"
      >
        {!workspaceId ? <option value="">Select workspace…</option> : null}
        {(workspaces ?? []).map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </NativeSelect>
    </div>
  )
}
