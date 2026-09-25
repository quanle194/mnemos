import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { KeyRound, LogOut } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import { ApiClient, ApiError, errorMessage, resolveApiUrl } from '@/api/client'
import { getMe, listWorkspaces } from '@/api/endpoints'
import { useMe, useWorkspaces } from '@/api/hooks/tenancy'
import { qk } from '@/api/keys'
import type { Me, Workspace } from '@/api/types'
import { useSession } from '@/auth/session-context'
import { Field } from '@/components/common/Field'
import { describedBy } from '@/lib/a11y'
import { ErrorState, LoadingState } from '@/components/common/States'
import { ThemeToggle } from '@/components/layout/ThemeToggle'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'

const loginSchema = z.object({
  apiKey: z.string().trim().min(8, 'Paste a Mnemos API key (e.g. mnm_…)'),
  apiUrl: z
    .string()
    .trim()
    .refine((v) => v === '' || v.startsWith('/') || /^https?:\/\/[^\s]+$/i.test(v), {
      message: 'Use a path like /api or a full http(s):// URL',
    }),
})
type LoginForm = z.infer<typeof loginSchema>

interface Pending {
  apiUrl: string | null
  apiKey: string
  me: Me
  workspaces: Workspace[]
}

interface LocationState {
  from?: string
  step?: 'workspace'
}

export function LoginPage() {
  const session = useSession()
  const location = useLocation()
  const state = (location.state ?? {}) as LocationState
  const from = state.from && state.from !== '/login' ? state.from : '/'
  const [pending, setPending] = useState<Pending | null>(null)

  if (session.isAuthenticated && session.workspaceId && state.step !== 'workspace' && !pending) {
    return <Navigate to={from} replace />
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-4">
      <div className="absolute top-3 right-3">
        <ThemeToggle />
      </div>
      <div className="flex items-center gap-2">
        <img src="/favicon.svg" alt="" className="size-8" />
        <span className="text-2xl font-semibold tracking-tight">Mnemos</span>
      </div>
      <Card className="w-full max-w-md">
        {pending ? (
          <WorkspaceStep
            workspaces={pending.workspaces}
            me={pending.me}
            onBack={() => setPending(null)}
            onContinue={(workspaceId) => {
              session.login({ apiUrl: pending.apiUrl, apiKey: pending.apiKey, workspaceId })
              return { me: pending.me, workspaces: pending.workspaces }
            }}
            from={from}
          />
        ) : session.isAuthenticated ? (
          <ExistingSessionWorkspaceStep from={from} />
        ) : (
          <KeyStep onValidated={setPending} />
        )}
      </Card>
      <p className="max-w-md text-center text-xs text-muted-foreground">
        The key is stored in this browser&apos;s localStorage and sent as a Bearer token to the Mnemos API
        only.
      </p>
    </div>
  )
}

function KeyStep({ onValidated }: { onValidated: (p: Pending) => void }) {
  const [serverError, setServerError] = useState<string | null>(null)
  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: { apiKey: '', apiUrl: '' },
  })
  const { errors, isSubmitting } = form.formState

  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null)
    const apiUrl = values.apiUrl || null
    const client = new ApiClient({ baseUrl: apiUrl, apiKey: values.apiKey })
    try {
      const me = await getMe(client)
      const workspaces = await listWorkspaces(client)
      onValidated({ apiUrl, apiKey: values.apiKey.trim(), me, workspaces })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setServerError('Invalid or revoked API key (401).')
      else setServerError(errorMessage(err))
    }
  })

  return (
    <>
      <CardHeader className="flex-col">
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" aria-hidden /> Connect to Mnemos
        </CardTitle>
        <CardDescription>
          Paste an API key. It is validated against GET /v1/me before being saved.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate data-testid="login-form">
          <Field id="login-api-key" label="API key" error={errors.apiKey?.message}>
            <Input
              id="login-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="mnm_xxxxxxxx_…"
              aria-invalid={Boolean(errors.apiKey)}
              aria-describedby={describedBy('login-api-key', errors.apiKey?.message)}
              data-testid="login-api-key"
              {...form.register('apiKey')}
            />
          </Field>
          <Field
            id="login-api-url"
            label="API URL (optional)"
            error={errors.apiUrl?.message}
            hint={
              <>
                Defaults to <code className="font-mono">{resolveApiUrl(null)}</code>.
              </>
            }
          >
            <Input
              id="login-api-url"
              placeholder={resolveApiUrl(null)}
              autoComplete="url"
              aria-invalid={Boolean(errors.apiUrl)}
              aria-describedby={describedBy('login-api-url', errors.apiUrl?.message, true)}
              data-testid="login-api-url"
              {...form.register('apiUrl')}
            />
          </Field>
          {serverError ? (
            <Alert variant="destructive" data-testid="login-error">
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" disabled={isSubmitting} data-testid="login-submit">
            {isSubmitting ? 'Validating…' : 'Connect'}
          </Button>
        </form>
      </CardContent>
    </>
  )
}

interface WorkspaceStepProps {
  workspaces: Workspace[]
  me: Me
  from: string
  onBack: () => void
  /** Persist the session; may return data to seed the query cache. */
  onContinue: (workspaceId: string) => { me: Me; workspaces: Workspace[] } | void
  initialId?: string | null
}

function WorkspaceStep({ workspaces, me, from, onBack, onContinue, initialId }: WorkspaceStepProps) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const preferred = initialId && workspaces.some((w) => w.id === initialId) ? initialId : workspaces[0]?.id
  const [selected, setSelected] = useState<string>(preferred ?? '')

  return (
    <>
      <CardHeader className="flex-col">
        <CardTitle>Choose a workspace</CardTitle>
        <CardDescription>
          Signed in as <span className="font-mono">{me.actor_id}</span>{' '}
          <Badge variant="outline" className="capitalize" data-testid="login-role">
            {me.role}
          </Badge>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {workspaces.length === 0 ? (
          <Alert variant="warning" data-testid="login-no-workspaces">
            <AlertDescription>
              This key cannot access any workspace. Ask an admin for a key with workspace access, or create
              one with the CLI (<code className="font-mono">mnemos admin bootstrap</code>).
            </AlertDescription>
          </Alert>
        ) : (
          <form
            className="flex flex-col gap-4"
            data-testid="workspace-select-form"
            onSubmit={(e) => {
              e.preventDefault()
              if (!selected) return
              const seeded = onContinue(selected)
              if (seeded) {
                qc.setQueryData(qk.me, seeded.me)
                qc.setQueryData(qk.workspaces, seeded.workspaces)
              }
              const ws = workspaces.find((w) => w.id === selected)
              toast.success(`Connected to workspace “${ws?.name ?? selected}”`)
              void navigate(from, { replace: true })
            }}
          >
            <Field id="workspace-select" label="Workspace">
              <NativeSelect
                id="workspace-select"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                data-testid="workspace-select"
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button type="submit" disabled={!selected} data-testid="workspace-continue">
              Continue
            </Button>
          </form>
        )}
        <Button variant="link" className="mt-2 px-0" onClick={onBack} data-testid="login-back">
          <LogOut /> Use a different key
        </Button>
      </CardContent>
    </>
  )
}

/** Already authenticated (e.g. redirected because the stored workspace vanished): only pick a workspace. */
function ExistingSessionWorkspaceStep({ from }: { from: string }) {
  const session = useSession()
  const workspaces = useWorkspaces()
  const me = useMe()
  if (workspaces.isPending || me.isPending) {
    return (
      <CardContent>
        <LoadingState rows={2} />
      </CardContent>
    )
  }
  if (workspaces.isError || me.isError) {
    return (
      <CardContent className="flex flex-col gap-3">
        <ErrorState
          error={workspaces.error ?? me.error}
          onRetry={() => {
            void workspaces.refetch()
            void me.refetch()
          }}
        />
        <Button variant="outline" onClick={() => session.logout()}>
          Sign out
        </Button>
      </CardContent>
    )
  }
  return (
    <WorkspaceStep
      workspaces={workspaces.data}
      me={me.data}
      from={from}
      initialId={session.workspaceId}
      onBack={() => session.logout()}
      onContinue={(id) => session.setWorkspace(id)}
    />
  )
}
