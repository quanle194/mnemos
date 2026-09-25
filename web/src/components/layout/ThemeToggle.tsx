import { Laptop, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTheme, type ThemePreference } from '@/lib/theme-context'

const NEXT: Record<ThemePreference, ThemePreference> = { light: 'dark', dark: 'system', system: 'light' }

export function ThemeToggle() {
  const { preference, setPreference } = useTheme()
  const Icon = preference === 'light' ? Sun : preference === 'dark' ? Moon : Laptop
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setPreference(NEXT[preference])}
      aria-label={`Theme: ${preference}. Switch to ${NEXT[preference]}`}
      title={`Theme: ${preference}`}
      data-testid="theme-toggle"
    >
      <Icon />
    </Button>
  )
}
