import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import type { StoredSession } from '@/auth/storage'
import { SessionProvider } from '@/auth/SessionProvider'
import { ThemeProvider } from '@/components/ThemeProvider'
import { Toaster } from '@/components/ui/sonner'
import { createQueryClient } from '@/lib/query-client'

interface Props {
  children: ReactNode
  queryClient?: QueryClient
  initialSession?: StoredSession
}

export function AppProviders({ children, queryClient, initialSession }: Props) {
  const [client] = useState(() => queryClient ?? createQueryClient())
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <SessionProvider initial={initialSession}>
          {children}
          <Toaster />
        </SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}
