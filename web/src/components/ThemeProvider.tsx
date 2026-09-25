import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { storage } from '@/lib/storage'
import { ThemeContext, type ThemePreference, type ThemeValue } from '@/lib/theme-context'

const KEY = 'mnemos.theme'

function systemPrefersDark(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  } catch {
    return false
  }
}

function readPreference(): ThemePreference {
  const v = storage.get(KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference)
  const [systemDark, setSystemDark] = useState(systemPrefersDark)

  useEffect(() => {
    let mq: MediaQueryList | undefined
    try {
      mq = globalThis.matchMedia?.('(prefers-color-scheme: dark)')
    } catch {
      mq = undefined
    }
    if (!mq) return
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener?.('change', onChange)
    return () => mq?.removeEventListener?.('change', onChange)
  }, [])

  const resolved: 'light' | 'dark' = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', resolved === 'dark')
    root.dataset.theme = resolved
  }, [resolved])

  const value = useMemo<ThemeValue>(
    () => ({
      preference,
      resolved,
      setPreference: (t) => {
        setPreferenceState(t)
        storage.set(KEY, t)
      },
    }),
    [preference, resolved],
  )
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
