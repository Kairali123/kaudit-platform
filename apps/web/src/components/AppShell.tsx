import {
  Activity,
  AudioLines,
  CalendarDays,
  CircleDollarSign,
  FileChartColumn,
  Gauge,
  Home,
  LogOut,
  Menu,
  PhoneCall,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  ScanSearch,
  UploadCloud,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import {
  Navigate,
  NavLink,
  Outlet,
  useLocation,
  useSearchParams,
} from 'react-router-dom'
import { ErrorState, LoadingState } from './States'
import {
  ApiError,
  getJson,
  type AuthConfig,
  type BillingPeriodsData,
  type Profile,
} from '../lib/api'
import {
  BillingPeriodProvider,
  type BillingPeriodContextValue,
} from '../lib/billingPeriod'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** Exact-path matching, so a parent link is not active on a child route. */
  end?: boolean
  /** Rendered only for the 'admin' role; omitted entirely for everyone else. */
  admin?: boolean
}

interface NavGroup {
  id: string
  label: string
  items: NavItem[]
}

/**
 * Navigation is grouped by SYSTEM, not by role. Billing Audit and Call Audit
 * are separate modules with separate data, separate periods and separate
 * access rules, and the sidebar has to say so: a flat list reads as one
 * product with an oddly named page in the middle of it.
 *
 * Admin-only destinations sit inside the group they administer rather than in
 * a trailing admin block, so the boundary a reader has to hold is the module
 * boundary and not a second, crossing one. Call Audit RULES carry prompts and
 * model settings and are admin-gated; Call Audit REPORTING is anonymous and
 * aggregate, so it is never gated on a role.
 */
const NAVIGATION_GROUPS: NavGroup[] = [
  {
    id: 'platform',
    label: 'Platform',
    items: [
      { to: '/', label: 'Home', icon: Home, end: true },
      { to: '/overview', label: 'Overview', icon: Gauge },
      {
        to: '/users',
        label: 'User management',
        icon: Users,
        admin: true,
      },
    ],
  },
  {
    id: 'billing-audit',
    label: 'Billing Audit',
    items: [
      { to: '/evidence', label: 'Calls & evidence', icon: AudioLines },
      { to: '/findings', label: 'Findings', icon: Sparkles },
      { to: '/billing', label: 'Billing', icon: CircleDollarSign },
      { to: '/reports', label: 'Reports', icon: FileChartColumn },
      { to: '/operations', label: 'Operations', icon: Activity },
      {
        to: '/imports/new',
        label: 'Import billing cycle',
        icon: UploadCloud,
        admin: true,
      },
      { to: '/audits', label: 'Audit monitor', icon: ScanSearch, admin: true },
    ],
  },
  {
    id: 'call-audit',
    label: 'Call Audit',
    items: [
      // `end` keeps the report link from lighting up on the rules child route.
      { to: '/call-audit', label: 'Call audit report', icon: PhoneCall, end: true },
      {
        to: '/call-audit/settings',
        label: 'Call audit rules',
        icon: SlidersHorizontal,
        admin: true,
      },
    ],
  },
]

/**
 * Whether the global bill month means anything on a path. Billing Audit reads
 * are scoped by bill month; Call Audit is a separate module that scopes itself
 * by cadence and UTC period, so carrying `?month=` onto its routes would claim
 * a filter those pages never apply. One predicate drives both the topbar
 * control and the links, so the URL can never disagree with the chrome.
 *
 * The name is deliberately unlike the component's `billMonthInScope` state:
 * a helper and a const that differ by one syllable invite a later edit that
 * makes them differ by none, and a const initialized from a same-named
 * function is a TDZ crash the type checker cannot see.
 */
function billMonthAppliesToPath(pathname: string): boolean {
  return !pathname.startsWith('/call-audit')
}

export function AppShell() {
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const profileQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => getJson<Profile>('/api/v1/me'),
    retry: false,
  })
  const authQuery = useQuery({
    queryKey: ['auth-config'],
    queryFn: () =>
      getJson<AuthConfig>('/api/v1/auth/config'),
    staleTime: 60_000,
  })
  const periodsQuery = useQuery({
    queryKey: ['billing-periods'],
    queryFn: () =>
      getJson<BillingPeriodsData>('/api/v1/periods'),
    enabled: profileQuery.isSuccess,
    staleTime: 30_000,
  })
  const billMonthInScope = billMonthAppliesToPath(location.pathname)
  const availableMonths = periodsQuery.data?.months ?? []
  const requestedMonth = searchParams.get('month')
  const monthIsAvailable =
    requestedMonth === 'all' ||
    availableMonths.some(
      (candidate) => candidate.month === requestedMonth,
    )
  const selectedMonth =
    monthIsAvailable && requestedMonth
      ? requestedMonth
      : periodsQuery.data?.defaultMonth ?? 'all'
  const selectedLabel =
    selectedMonth === 'all'
      ? 'All periods'
      : availableMonths.find(
          (candidate) => candidate.month === selectedMonth,
        )?.label ?? selectedMonth
  useEffect(() => {
    // Defaulting the month on a Call Audit route would stamp a billing filter
    // into a URL that module never reads, and it would fight the page's own
    // query params on every render.
    if (!periodsQuery.data || monthIsAvailable || !billMonthInScope) return
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.set(
        'month',
        periodsQuery.data.defaultMonth ?? 'all',
      )
      return next
    }, { replace: true })
  }, [
    billMonthInScope,
    monthIsAvailable,
    periodsQuery.data,
    setSearchParams,
  ])
  const periodContext = useMemo<BillingPeriodContextValue>(() => {
    const withMonth = (target: string): string => {
      const [pathname, existing = ''] = target.split('?')
      if (!billMonthAppliesToPath(pathname)) return target
      const params = new URLSearchParams(existing)
      params.set('month', selectedMonth)
      return `${pathname}?${params.toString()}`
    }
    return {
      month: selectedMonth,
      label: selectedLabel,
      apiPath: withMonth,
      routePath: withMonth,
    }
  }, [selectedLabel, selectedMonth])
  if (
    profileQuery.error instanceof ApiError &&
    profileQuery.error.status === 401
  ) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    )
  }
  if (profileQuery.isLoading) return <LoadingState />
  if (profileQuery.error) {
    return (
      <ErrorState
        error={profileQuery.error}
        retry={() => void profileQuery.refetch()}
      />
    )
  }
  const profile = profileQuery.data
  const auth = authQuery.data
  const secured = profile?.accessControlEnforced === true
  const isAdmin = profile?.roles.includes('admin') === true
  return (
    <BillingPeriodProvider value={periodContext}>
      <div className="app-shell">
      <aside className={open ? 'sidebar open' : 'sidebar'}>
        <div className="brand">
          <span className="brand-mark">K</span>
          <span>
            <strong>Kairali Audit</strong>
            <small>Control platform</small>
          </span>
          <button
            className="icon-button sidebar-close"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
            type="button"
          >
            <X size={18} />
          </button>
        </div>
        <nav aria-label="Primary">
          {NAVIGATION_GROUPS.map((group) => {
            const items = group.items.filter(
              (item) => !item.admin || isAdmin,
            )
            // A heading over nothing is worse than a missing section.
            if (items.length === 0) return null
            return (
              <section
                key={group.id}
                className="nav-group"
                aria-labelledby={`nav-group-${group.id}`}
              >
                <h2 className="nav-group-label" id={`nav-group-${group.id}`}>
                  {group.label}
                </h2>
                {items.map(({ to, label, icon: Icon, end }) => (
                  <NavLink
                    key={to}
                    to={periodContext.routePath(to)}
                    end={end}
                    onClick={() => setOpen(false)}
                    title={label}
                  >
                    <Icon size={18} aria-hidden />
                    <span>{label}</span>
                  </NavLink>
                ))}
              </section>
            )
          })}
        </nav>
        <div className="sidebar-footer">
          <ShieldCheck size={17} aria-hidden />
          <div>
            <strong>Aggregate by default</strong>
            <span>Call content is admin-only and access-logged</span>
          </div>
        </div>
      </aside>
      {open && (
        <button
          className="sidebar-scrim"
          onClick={() => setOpen(false)}
          aria-label="Close navigation"
          type="button"
        />
      )}
      <div className="workspace">
        <div className="topbar">
          <button
            className="icon-button menu-button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            type="button"
          >
            <Menu size={20} />
          </button>
          <div className="environment">
            <span />
            {secured ? 'Private workspace' : 'Local preview'}
          </div>
          {!billMonthInScope ? null : (
            <label className="billing-period-filter">
              <CalendarDays size={16} aria-hidden />
              <span>Bill month</span>
              <select
                aria-label="Global bill month"
                value={selectedMonth}
                disabled={periodsQuery.isLoading}
                onChange={(event) => {
                  setSearchParams((current) => {
                    const next = new URLSearchParams(current)
                    next.set('month', event.target.value)
                    next.delete('page')
                    return next
                  })
                }}
              >
                {availableMonths.map((period) => (
                  <option value={period.month} key={period.month}>
                    {period.label} · {period.callCount.toLocaleString('en-IN')} calls
                  </option>
                ))}
                <option value="all">All periods</option>
              </select>
            </label>
          )}
          <div className="topbar-right">
            <span>
              {secured
                ? 'Access control enforced'
                : 'Access control not enforced'}
            </span>
            <Shield size={16} aria-label="Session managed by identity provider" />
            {auth?.logoutUrl && (
              <a className="logout-button" href="/logout">
                <LogOut size={15} aria-hidden />
                <span>
                  {auth.mode === 'preview'
                    ? 'Exit preview'
                    : 'Log out'}
                </span>
              </a>
            )}
          </div>
        </div>
        <main className="page">
          <Outlet />
        </main>
      </div>
      </div>
    </BillingPeriodProvider>
  )
}
