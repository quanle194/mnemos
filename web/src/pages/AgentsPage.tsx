import { Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useAgents, useCreateAgent, useCreateProject, useProjects } from '@/api/hooks/tenancy'
import { usePermissions } from '@/auth/permissions'
import { useWorkspaceId } from '@/auth/session-context'
import { IdText } from '@/components/common/IdText'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/States'
import { TimeAgo } from '@/components/common/TimeAgo'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

function AgentsCard({ ws, canCreate }: { ws: string; canCreate: boolean }) {
  const q = useAgents(ws)
  const create = useCreateAgent(ws)
  const [name, setName] = useState('')
  const [kind, setKind] = useState('agent')
  return (
    <Card>
      <CardHeader className="flex-col">
        <CardTitle className="text-base">Agents</CardTitle>
        <CardDescription>Actors that record experiences and retrieve context in this workspace.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canCreate ? (
          <form
            className="flex flex-wrap items-end gap-2"
            data-testid="agent-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (!name.trim()) return
              create.mutate(
                { name: name.trim(), kind: kind.trim() || 'agent' },
                {
                  onSuccess: (a) => {
                    toast.success(`Agent “${a.name}” ready`)
                    setName('')
                  },
                },
              )
            }}
          >
            <div className="flex min-w-40 flex-1 flex-col gap-1.5">
              <Label htmlFor="agent-name">Name</Label>
              <Input
                id="agent-name"
                value={name}
                maxLength={200}
                required
                onChange={(e) => setName(e.target.value)}
                data-testid="agent-name"
              />
            </div>
            <div className="flex w-32 flex-col gap-1.5">
              <Label htmlFor="agent-kind">Kind</Label>
              <Input id="agent-kind" value={kind} maxLength={50} onChange={(e) => setKind(e.target.value)} data-testid="agent-kind" />
            </div>
            <Button type="submit" disabled={create.isPending || !name.trim()} data-testid="agent-submit">
              <Plus /> Add agent
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
        ) : q.data.length === 0 ? (
          <EmptyState title="No agents yet">Agents are created automatically when they first record an experience.</EmptyState>
        ) : (
          <Table data-testid="agent-list">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Id</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((a) => (
                <TableRow key={a.id} data-testid="agent-row" data-id={a.id}>
                  <TableCell className="font-medium">{a.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{a.kind}</Badge>
                  </TableCell>
                  <TableCell>
                    <IdText id={a.id} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <TimeAgo iso={a.created_at} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

function ProjectsCard({ ws, canCreate }: { ws: string; canCreate: boolean }) {
  const q = useProjects(ws)
  const create = useCreateProject(ws)
  const [name, setName] = useState('')
  return (
    <Card>
      <CardHeader className="flex-col">
        <CardTitle className="text-base">Projects</CardTitle>
        <CardDescription>Project scope sits between workspace and agent in the scope hierarchy.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canCreate ? (
          <form
            className="flex flex-wrap items-end gap-2"
            data-testid="project-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (!name.trim()) return
              create.mutate(
                { name: name.trim() },
                {
                  onSuccess: (p) => {
                    toast.success(`Project “${p.name}” ready`)
                    setName('')
                  },
                },
              )
            }}
          >
            <div className="flex min-w-40 flex-1 flex-col gap-1.5">
              <Label htmlFor="project-name">Name</Label>
              <Input
                id="project-name"
                value={name}
                maxLength={200}
                required
                onChange={(e) => setName(e.target.value)}
                data-testid="project-name"
              />
            </div>
            <Button type="submit" disabled={create.isPending || !name.trim()} data-testid="project-submit">
              <Plus /> Add project
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
        ) : q.data.length === 0 ? (
          <EmptyState title="No projects yet" />
        ) : (
          <Table data-testid="project-list">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Id</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {q.data.map((p) => (
                <TableRow key={p.id} data-testid="project-row" data-id={p.id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell>
                    <IdText id={p.id} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    <TimeAgo iso={p.created_at} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

export function AgentsPage() {
  const ws = useWorkspaceId()
  const { can } = usePermissions()
  const canCreate = can('experience:write')
  return (
    <>
      <PageHeader title="Agents & projects" description="Identities and project scopes within the active workspace." />
      <div className="grid gap-5 lg:grid-cols-2">
        <AgentsCard ws={ws} canCreate={canCreate} />
        <ProjectsCard ws={ws} canCreate={canCreate} />
      </div>
    </>
  )
}
