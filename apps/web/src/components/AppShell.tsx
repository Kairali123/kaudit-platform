import {
  Activity,
  AudioLines,
  CircleDollarSign,
  FileChartColumn,
  Gauge,
  Home,
  Menu,
  Shield,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { getJson, type Profile } from '../lib/api'

const navigation = [
  { to: '/', label: 'Home', icon: Home, end: true },
  { to: '/overview', label: 'Overview', icon: Gauge },
  { to: '/evidence', label: 'Calls & evidence', icon: AudioLines },
  { to: '/findings', label: 'Findings', icon: Sparkles },
  { to: '/billing', label: 'Billing', icon: CircleDollarSign },
  { to: '/reports', label: 'Reports', icon: FileChartColumn },
  { to: '/operations', label: 'Operations', icon: Activity },
]

export function AppShell() {
  const [open, setOpen] = useState(false)
  const profile = useQuery({
    queryKey: ['me'],
    queryFn: () => getJson<Profile>('/api/v1/me'),
  }).data
  const secured = profile?.accessControlEnforced === true
  return (
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
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setOpen(false)}
              title={label}
            >
              <Icon size={18} aria-hidden />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <ShieldCheck size={17} aria-hidden />
          <div>
            <strong>Aggregate-only</strong>
            <span>No audio, transcript, or health content</span>
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
          <div className="topbar-right">
            <span>
              {secured
                ? 'Access control enforced'
                : 'Access control not enforced'}
            </span>
            <Shield size={16} aria-label="Session managed by identity provider" />
          </div>
        </div>
        <main className="page">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
