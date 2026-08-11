import { createContext, useContext } from 'react'

export interface BillingPeriodContextValue {
  month: string
  label: string
  apiPath: (path: string) => string
  routePath: (path: string) => string
}

function appendMonth(path: string, month: string): string {
  const [pathname, existing = ''] = path.split('?')
  const params = new URLSearchParams(existing)
  params.set('month', month)
  return `${pathname}?${params.toString()}`
}

const BillingPeriodContext =
  createContext<BillingPeriodContextValue>({
    month: 'all',
    label: 'All periods',
    apiPath: (path) => appendMonth(path, 'all'),
    routePath: (path) => appendMonth(path, 'all'),
  })

export const BillingPeriodProvider = BillingPeriodContext.Provider

export function useBillingPeriod(): BillingPeriodContextValue {
  return useContext(BillingPeriodContext)
}
