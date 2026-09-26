import { NavLink } from 'react-router'
import { cn } from '@/lib/utils'
import { NAV_ITEMS } from './nav'

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main navigation" className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          data-testid={item.testId}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors hover:bg-sidebar-accent',
              isActive ? 'bg-sidebar-accent text-foreground' : 'text-sidebar-foreground/80',
            )
          }
        >
          <item.icon className="size-4 shrink-0" aria-hidden />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}

export function Brand() {
  return (
    <div className="flex items-center gap-2 px-2.5 py-1">
      <img src="/favicon.svg" alt="" className="size-6" />
      <span className="text-base font-semibold tracking-tight">Mnemos</span>
    </div>
  )
}
