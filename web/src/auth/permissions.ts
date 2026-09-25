import { useMe } from '@/api/hooks/tenancy'
import type { Me, Permission } from '@/api/types'

export interface Permissions {
  me: Me | undefined
  can: (permission: Permission) => boolean
  /** Workspace-restricted keys cannot create workspaces even with workspace:manage. */
  isOrgWide: boolean
}

export function permissionsFor(me: Me | undefined): Permissions {
  const set = new Set<string>(me?.permissions ?? [])
  return { me, can: (p) => set.has(p), isOrgWide: me ? me.workspace_ids === null : false }
}

export function usePermissions(): Permissions {
  const { data } = useMe()
  return permissionsFor(data)
}
