import { createContext, useContext } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'

export interface ThemeValue {
  preference: ThemePreference
  resolved: 'light' | 'dark'
  setPreference: (t: ThemePreference) => void
}

export const ThemeContext = createContext<ThemeValue>({
  preference: 'system',
  resolved: 'light',
  setPreference: () => {},
})

export function useTheme(): ThemeValue {
  return useContext(ThemeContext)
}
