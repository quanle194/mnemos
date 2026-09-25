import { storage } from '@/lib/storage'

export const SESSION_STORAGE_KEY = 'mnemos.session.v1'

export interface StoredSession {
  /** Explicit API URL override chosen at login (null = VITE_API_URL or `/api`). */
  apiUrl: string | null
  apiKey: string | null
  workspaceId: string | null
}

export const EMPTY_SESSION: StoredSession = { apiUrl: null, apiKey: null, workspaceId: null }

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

export function loadSession(): StoredSession {
  const raw = storage.get(SESSION_STORAGE_KEY)
  if (!raw) return EMPTY_SESSION
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return { apiUrl: str(parsed.apiUrl), apiKey: str(parsed.apiKey), workspaceId: str(parsed.workspaceId) }
  } catch {
    return EMPTY_SESSION
  }
}

export function saveSession(s: StoredSession): void {
  storage.set(SESSION_STORAGE_KEY, JSON.stringify(s))
}

export function clearSession(): void {
  storage.remove(SESSION_STORAGE_KEY)
}
