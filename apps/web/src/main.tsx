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
      /**
       * A server answer is not a lost packet.
       *
       * Retrying a 5xx immediately doubled the load on a database that had just
       * failed to answer the same heavy aggregate, which is exactly when the
       * monitor's reads are already queued behind each other. Anything the
       * server actually answered — a timeout, an unavailable dependency, a
       * refusal — is surfaced to the operator with its own retry control rather
       * than replayed automatically. A transport failure with no server answer
       * still gets one retry.
       */
      retry: (failureCount, error) =>
        !(error instanceof ApiError) && failureCount < 1,
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
