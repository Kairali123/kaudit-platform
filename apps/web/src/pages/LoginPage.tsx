import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react'
import { type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getJson,
  postJson,
  type AuthConfig,
} from '../lib/api'

export function LoginPage() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const query = useQuery({
    queryKey: ['auth-config'],
    queryFn: () =>
      getJson<AuthConfig>('/api/v1/auth/config'),
    retry: 1,
    staleTime: 60_000,
  })
  const auth = query.data
  const preview = auth?.mode === 'preview'
  const local = auth?.mode === 'local'
  const destination =
    auth?.mode === 'oidc' ? auth.loginUrl : '/'
  const ready = Boolean(destination)
  const login = useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      postJson<{ authenticated: true; email: string }>(
        '/api/v1/auth/login',
        input,
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['me'] })
      navigate('/', { replace: true })
    },
  })
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    login.mutate({
      email: String(form.get('email') || ''),
      password: String(form.get('password') || ''),
    })
  }

  return (
    <main className="login-page">
      <section className="login-story" aria-label="Platform introduction">
        <div className="login-brand">
          <span className="brand-mark">K</span>
          <span>
            <strong>Kairali Audit</strong>
            <small>Voice quality & revenue control</small>
          </span>
        </div>
        <div className="login-story-copy">
          <span className="eyebrow">Independent control platform</span>
          <h1>Evidence-led assurance for every audited call.</h1>
          <p>
            Monitor evidence integrity, quality signals, billing,
            reconciliation, and management revenue snapshots from one
            protected workspace.
          </p>
        </div>
        <ul className="login-trust-list">
          <li>
            <CheckCircle2 size={17} aria-hidden />
            Aggregate-only dashboard
          </li>
          <li>
            <CheckCircle2 size={17} aria-hidden />
            Role-based internal access
          </li>
          <li>
            <CheckCircle2 size={17} aria-hidden />
            Traceable financial and AI decisions
          </li>
        </ul>
      </section>

      <section className="login-panel" aria-label="Sign in">
        <div className="login-card">
          <div className="login-icon">
            <ShieldCheck size={25} aria-hidden />
          </div>
          <span className="eyebrow">Secure access</span>
          <h2>Sign in to your workspace</h2>
          <p className="login-intro">
            Use your approved Kairali identity. Local credentials are
            accepted only by this loopback development server.
          </p>

          {query.isLoading && (
            <div className="login-loading" aria-live="polite">
              Checking sign-in configuration…
            </div>
          )}

          {query.error && (
            <div className="login-message danger" role="alert">
              Sign-in configuration could not be loaded. Confirm the
              local server is running and try again.
            </div>
          )}

          {auth && (
            <>
              <div className="identity-provider">
                <Building2 size={18} aria-hidden />
                <div>
                  <span>Identity provider</span>
                  <strong>{auth.providerLabel}</strong>
                </div>
                <span
                  className={`provider-state ${
                    auth.accessControlEnforced
                      ? 'secured'
                      : 'preview'
                  }`}
                >
                  {auth.accessControlEnforced
                    ? 'secured'
                    : 'preview'}
                </span>
              </div>

              {preview && (
                <div className="login-message warning">
                  Preview mode has no real user authentication. It is
                  restricted to this computer and must not be exposed.
                </div>
              )}

              {local && (
                <div className="login-message info">
                  Local sign-in is for development only. The password
                  is verified server-side and is never stored in the
                  browser.
                </div>
              )}

              {auth.mode === 'oidc' && !auth.loginUrl && (
                <div className="login-message danger">
                  Kairali SSO login is not configured yet. Set the
                  approved identity-provider login URL before release.
                </div>
              )}

              {local ? (
                <form className="login-form" onSubmit={submit}>
                  <label>
                    Email
                    <input
                      required
                      type="email"
                      name="email"
                      autoComplete="username"
                      autoFocus
                    />
                  </label>
                  <label>
                    Password
                    <input
                      required
                      type="password"
                      name="password"
                      autoComplete="current-password"
                    />
                  </label>
                  {login.error && (
                    <div
                      className="login-message danger"
                      role="alert"
                    >
                      {login.error.message}
                    </div>
                  )}
                  <button
                    className="login-button"
                    disabled={login.isPending}
                    type="submit"
                  >
                    {login.isPending
                      ? 'Signing in…'
                      : 'Sign in'}
                    <ArrowRight size={17} aria-hidden />
                  </button>
                </form>
              ) : ready ? (
                <a className="login-button" href={destination!}>
                  {preview
                    ? 'Enter local preview'
                    : 'Continue with Kairali SSO'}
                  <ArrowRight size={17} aria-hidden />
                </a>
              ) : (
                <button className="login-button" disabled type="button">
                  Sign-in unavailable
                  <LockKeyhole size={17} aria-hidden />
                </button>
              )}
            </>
          )}

          <div className="login-boundary">
            <LockKeyhole size={16} aria-hidden />
            <p>
              Raw audio, transcripts, customer identifiers, and
              free-text call content are not displayed by this application.
            </p>
          </div>
        </div>
        <p className="login-support">
          Access is limited to authorized Kairali personnel.
        </p>
      </section>
    </main>
  )
}
