import {
  Boxes,
  Brain,
  FlaskConical,
  GitFork,
  LayoutDashboard,
  type LucideIcon,
  MoonStar,
  Network,
  Settings,
  Swords,
  Users,
} from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  testId: string
  end?: boolean
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, testId: 'nav-overview', end: true },
  { to: '/memories', label: 'Memories', icon: Brain, testId: 'nav-memories' },
  { to: '/experiences', label: 'Experiences', icon: GitFork, testId: 'nav-experiences' },
  { to: '/dreams', label: 'Dreams', icon: MoonStar, testId: 'nav-dreams' },
  { to: '/conflicts', label: 'Conflicts', icon: Swords, testId: 'nav-conflicts' },
  { to: '/graph', label: 'Knowledge graph', icon: Network, testId: 'nav-graph' },
  { to: '/agents', label: 'Agents & projects', icon: Users, testId: 'nav-agents' },
  { to: '/workspaces', label: 'Workspaces & keys', icon: Boxes, testId: 'nav-workspaces' },
  { to: '/evals', label: 'Evals', icon: FlaskConical, testId: 'nav-evals' },
  { to: '/settings', label: 'Settings', icon: Settings, testId: 'nav-settings' },
]
