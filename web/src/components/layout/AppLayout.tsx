import { LogOut, Menu } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { useMe, useWorkspaces } from '@/api/hooks/tenancy'
import { ErrorState, LoadingState } from '@/components/common/States'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useSession } from '@/auth/session-context'
import { Brand, SidebarNav } from './SidebarNav'
import { ThemeToggle } from './ThemeToggle'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

export function AppLayout() {
  const session = useSession()
  const location = useLocation()
  const me = useMe()
  const workspaces = useWorkspaces()
  const [mobileOpen, setMobileOpen] = useState(false)

  const workspaceMissing =
    workspaces.isSuccess && session.workspaceId !== null && !workspaces.data.some((w) => w.id === session.workspaceId)

  useEffect(() => setMobileOpen(false), [location.pathname])

  if (!session.isAuthenticated) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  if (!session.workspaceId || workspaceMissing) {
    return <Navigate to="/login" replace state={{ from: location.pathname, step: 'workspace' }} />
  }

  if (me.isPending) {
    return (
      <div className="mx-auto max-w-md p-8">
        <LoadingState rows={4} label="Checking API key…" />
      </div>
    )
  }
  if (me.isError) {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-3 p-8">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} title="Cannot load identity" />
        <Button variant="outline" onClick={() => session.logout()}>
          Sign out
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-4 border-r bg-sidebar p-3 md:flex">
        <Brand />
        <SidebarNav />
      </aside>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent aria-describedby={undefined}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Brand />
          <SidebarNav onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur sm:px-5">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
            data-testid="nav-toggle"
          >
            <Menu />
          </Button>
          <WorkspaceSwitcher />
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <Badge variant="outline" className="hidden capitalize sm:inline-flex" data-testid="current-role">
              {me.data.role}
            </Badge>
            <ThemeToggle />
            <Button variant="ghost" size="sm" onClick={() => session.logout()} data-testid="logout-button">
              <LogOut />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </header>
        <main className="mx-auto flex w-full max-w-7xl min-w-0 flex-1 flex-col gap-5 p-4 sm:p-6" id="main">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
