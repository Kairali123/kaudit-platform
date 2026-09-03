import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App'
import { ApiError } from './lib/api'
import './styles.css'

/**
 * Background polling is OPT-IN, never a default.
 *
 * A global `refetchInterval` made every mounted query re-hit the API forever,
 * including screens whose data only changes when the operator navigates or
 * submits something (home, overview, evidence, findings, billing, reports,
 * profile/auth/period). Those reads are expensive aggregates, so the default
 * client now refetches on mount/invalidation only; a screen whose displayed
 * state genuinely moves on its own declares its own bounded interval.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status === 504) &&
        failureCount < 1,
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
