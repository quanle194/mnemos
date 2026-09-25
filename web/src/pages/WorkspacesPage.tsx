import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import {
  useApiKeys,
  useCreateApiKey,
  useCreateWorkspace,
  useRevokeApiKey,
  useWorkspaces,
} from '@/api/hooks/tenancy'
import { ROLES, type ApiKey, type ApiKeyCreated, type Role } from '@/api/types'
import { usePermissions } from '@/auth/permissions'
import { useSession } from '@/auth/session-context'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { IdText } from '@/components/common/IdText'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { TimeAgo } from '@/components/common/TimeAgo'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const ROLE_HELP: Record<Role, string> = {
  viewer: 'read memories',
  agent: 'record experiences, propose memories, feedback',
  maintainer: 'agent + review/promote, run dreams',
  admin: 'maintainer + manage workspaces and API keys',
}

function WorkspacesCard() {
  const session = useSession()
  const { can, isOrgWide } = usePermissions()
  const q = useWorkspaces()
  const create = useCreateWorkspace()
  const [name, setName] = useState('')
  const canCreate = can('workspace:manage') && isOrgWide

  return (
    <Card>
      <CardHeader className="flex-col">
        <CardTitle className="text-base">Workspaces</CardTitle>
        <CardDescription>
          Tenant partitions inside your organization. The active one scopes every screen.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canCreate ? (
          <form
            className="flex flex-wrap items-end gap-2"
            data-testid="workspace-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (!name.trim()) return
              create.mutate(
                { name: name.trim() },
                {
                  onSuccess: (w) => {
                    toast.success(`Workspace “${w.name}” created`)
                    setName('')
                  },
                },
              )
            }}
          >
            <div className="flex min-w-48 flex-1 flex-col gap-1.5">
              <Label htmlFor="workspace-name">New workspace name</Label>
              <Input
                id="workspace-name"
                value={name}
                maxLength={200}
                required
                onChange={(e) => setName(e.target.value)}
                data-testid="workspace-name"
              />
            </div>
            <Button type="submit" disabled={create.isPending || !name.trim()} data-testid="workspace-submit">
              <Plus /> Create
            </Button>
          </form>
        ) : null}
        {create.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage(create.error)}</AlertDescription>
          </Alert>
        ) : null}
        {q.isPending ? (
          <LoadingState rows={3} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <Table data-testid="workspace-list">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Id</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Active</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((w) => {
                const active = w.id === session.workspaceId
                return (
                  <TableRow key={w.id} data-testid="workspace-row" data-id={w.id} data-active={active}>
                    <TableCell className="font-medium">{w.name}</TableCell>
                    <TableCell>
                      <IdText id={w.id} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <TimeAgo iso={w.created_at} />
                    </TableCell>
                    <TableCell className="text-right">
                      {active ? (
                        <Badge variant="success">
                          <Check /> Active
                        </Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            session.setWorkspace(w.id)
                            toast.success(`Switched to workspace “${w.name}”`)
                          }}
                          data-testid="workspace-switch"
                        >
                          Switch
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function CreatedKeyDialog({ created, onClose }: { created: ApiKeyCreated | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.api_key)
      setCopied(true)
    } catch {
      toast.error('Clipboard unavailable (needs HTTPS). Select the key and copy it manually.')
    }
  }
  return (
    <Dialog open={created !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="api-key-created-dialog">
        <DialogHeader>
          <DialogTitle>API key created</DialogTitle>
          <DialogDescription>
            Copy it now — Mnemos stores only a hash, so this key will <strong>never be shown again</strong>.
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="created-key">
              {created.name} ({created.role})
            </Label>
            <div className="flex gap-2">
              <Input
                id="created-key"
                readOnly
                value={created.api_key}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
                data-testid="api-key-created-value"
              />
              <Button variant="outline" size="icon" onClick={() => void copy()} aria-label="Copy API key">
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button onClick={onClose} data-testid="api-key-created-close">
            I have stored the key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ApiKeysCard() {
  const workspaces = useWorkspaces()
  const keys = useApiKeys()
  const create = useCreateApiKey()
  const revoke = useRevokeApiKey()
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('agent')
  const [scoped, setScoped] = useState<string[]>([])
  const [created, setCreated] = useState<ApiKeyCreated | null>(null)
  const [toRevoke, setToRevoke] = useState<ApiKey | null>(null)
  const wsName = (id: string) => workspaces.data?.find((w) => w.id === id)?.name ?? id.slice(0, 8)

  return (
    <Card>
      <CardHeader className="flex-col">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4" aria-hidden /> API keys
        </CardTitle>
        <CardDescription>
          Keys carry one role and optionally a workspace allow-list. Raw keys are shown once.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form
          className="grid gap-3 rounded-lg border bg-muted/30 p-3 sm:grid-cols-3"
          data-testid="api-key-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            create.mutate(
              { name: name.trim(), role, workspace_ids: scoped.length ? scoped : null },
              {
                onSuccess: (k) => {
                  setCreated(k)
                  setName('')
                  setScoped([])
                },
              },
            )
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="api-key-name">Name</Label>
            <Input
              id="api-key-name"
              value={name}
              required
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              data-testid="api-key-name"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="api-key-role">Role</Label>
            <NativeSelect
              id="api-key-role"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              data-testid="api-key-role"
              aria-describedby="api-key-role-help"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </NativeSelect>
            <p id="api-key-role-help" className="text-xs text-muted-foreground">
              {ROLE_HELP[role]}
            </p>
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-sm font-medium">Workspaces</legend>
            <div className="flex max-h-28 flex-col gap-1 overflow-y-auto text-sm">
              {(workspaces.data ?? []).map((w) => (
                <label key={w.id} className="flex items-center gap-2">
                  <Checkbox
                    checked={scoped.includes(w.id)}
                    onChange={(e) =>
                      setScoped((s) => (e.target.checked ? [...s, w.id] : s.filter((x) => x !== w.id)))
                    }
                    data-testid="api-key-workspace"
                  />
                  {w.name}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">None selected = all workspaces</p>
          </fieldset>
          {create.isError ? (
            <Alert variant="destructive" className="sm:col-span-3">
              <AlertDescription>{errorMessage(create.error)}</AlertDescription>
            </Alert>
          ) : null}
          <div className="sm:col-span-3">
            <Button type="submit" disabled={create.isPending || !name.trim()} data-testid="api-key-submit">
              <Plus /> Create key
            </Button>
          </div>
        </form>

        {keys.isPending ? (
          <LoadingState rows={3} />
        ) : keys.isError ? (
          <ErrorState error={keys.error} onRetry={() => void keys.refetch()} />
        ) : keys.data.length === 0 ? (
          <EmptyState title="No API keys" />
        ) : (
          <Table data-testid="api-key-list">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Workspaces</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.data.map((k) => (
                <TableRow
                  key={k.id}
                  data-testid="api-key-row"
                  data-id={k.id}
                  data-revoked={Boolean(k.revoked_at)}
                >
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell className="font-mono text-xs">{k.prefix}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {k.role}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-48 text-xs">
                    {k.workspace_ids ? k.workspace_ids.map(wsName).join(', ') : 'All'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <TimeAgo iso={k.last_used_at} />
                  </TableCell>
                  <TableCell>
                    {k.revoked_at ? (
                      <Badge variant="destructive">Revoked</Badge>
                    ) : (
                      <Badge variant="success">Active</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {!k.revoked_at ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => setToRevoke(k)}
                        data-testid="api-key-revoke"
                      >
                        <Trash2 /> Revoke
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <CreatedKeyDialog created={created} onClose={() => setCreated(null)} />
      <ConfirmDialog
        open={toRevoke !== null}
        onOpenChange={(o) => !o && setToRevoke(null)}
        title={`Revoke key “${toRevoke?.name ?? ''}”?`}
        description="Clients using this key will immediately receive 401. This cannot be undone."
        confirmLabel="Revoke"
        destructive
        pending={revoke.isPending}
        data-testid="api-key-revoke-dialog"
        onConfirm={() =>
          toRevoke &&
          revoke.mutate(toRevoke.id, {
            onSuccess: () => {
              toast.success('Key revoked')
              setToRevoke(null)
            },
            onError: (err) => toast.error(errorMessage(err)),
          })
        }
      />
    </Card>
  )
}

export function WorkspacesPage() {
  const { can } = usePermissions()
  return (
    <>
      <PageHeader title="Workspaces & API keys" description="Tenancy and access management." />
      <WorkspacesCard />
      {can('workspace:manage') ? (
        <ApiKeysCard />
      ) : (
        <Alert>
          <AlertTitle>API key management</AlertTitle>
          <AlertDescription>Requires the workspace:manage permission (admin role).</AlertDescription>
        </Alert>
      )}
    </>
  )
}
