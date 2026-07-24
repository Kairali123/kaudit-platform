import { useQuery } from '@tanstack/react-query'
import { ArrowRight, LockKeyhole, ShieldCheck, UserRound } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ErrorState, LoadingState, Notice } from '../components/States'
import { PageHeader } from '../components/Metrics'
import { getJson, type Profile } from '../lib/api'

export function HomePage() {
  const query = useQuery({
    queryKey: ['me'],
    queryFn: () => getJson<Profile>('/api/v1/me'),
  })
  if (query.isLoading) return <LoadingState />
  if (query.error)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />
  const profile = query.data!
  return (
    <>
      <PageHeader
        eyebrow="Home"
        title="Your audit workspace"
        description="Identity, access scope, and a clear route into each operational area."
        badge={<span className="status-badge ready">Authenticated</span>}
      />
      <section className="profile-layout">
        <article className="profile-card">
          <div className="avatar" aria-hidden>
            {profile.email.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <span className="eyebrow">Signed in as</span>
            <h2>{profile.email}</h2>
            <div className="role-row">
              {profile.roles.map((role) => (
                <span className="role-chip" key={role}>
                  {role}
                </span>
              ))}
            </div>
          </div>
        </article>
        <div className="access-grid">
          <article>
            <UserRound size={18} aria-hidden />
            <span>Identity</span>
            <strong>{profile.authMode.toUpperCase()}</strong>
            <small>Server-validated session</small>
          </article>
          <article>
            <ShieldCheck size={18} aria-hidden />
            <span>Role</span>
            <strong>{profile.roles.join(', ') || 'Unassigned'}</strong>
            <small>Deny by default</small>
          </article>
          <article>
            <LockKeyhole size={18} aria-hidden />
            <span>Sensitivity ceiling</span>
            <strong>{profile.maxSensitivityTier}</strong>
            <small>Admin-managed and audited</small>
          </article>
        </div>
      </section>
      <Notice tone="info" title="Content boundary enforced">
        {profile.contentAccess}
      </Notice>
      <section className="permission-panel" aria-label="Granted permissions">
        <div>
          <span className="eyebrow">Effective access</span>
          <h2>Granted permissions</h2>
        </div>
        <div className="permission-list">
          {profile.permissions.length ? (
            profile.permissions.map((permission) => (
              <code key={permission}>
                {permission === '*' ? 'admin:all' : permission}
              </code>
            ))
          ) : (
            <span className="muted">No operational permissions assigned.</span>
          )}
        </div>
      </section>
      <section className="quick-links">
        <div className="section-title">
          <div>
            <span className="eyebrow">Workspace</span>
            <h2>Continue to</h2>
          </div>
        </div>
        <div className="link-grid">
          {[
            ['/overview', 'Platform overview', 'Release posture and headline metrics'],
            ['/evidence', 'Calls & evidence', 'Ingestion and hash-verification coverage'],
            ['/findings', 'Findings', 'Automated quality signals and confidence'],
            ['/billing', 'Billing', 'Calculated amount and reconciliation posture'],
          ].map(([to, title, detail]) => (
            <Link to={to} key={to}>
              <span>
                <strong>{title}</strong>
                <small>{detail}</small>
              </span>
              <ArrowRight size={17} aria-hidden />
            </Link>
          ))}
        </div>
      </section>
    </>
  )
}
