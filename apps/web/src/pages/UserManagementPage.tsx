import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  KeyRound,
  Pencil,
  Plus,
  Power,
  PowerOff,
  ShieldCheck,
  Trash2,
  UserCog,
  X,
} from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { PageHeader } from '../components/Metrics'
import { ErrorState, LoadingState, Notice } from '../components/States'
import {
  getJson,
  postJson,
  type UserAdminChangeResult,
  type UserAdminListItem,
  type UserAdminListPage,
  type UserRole,
} from '../lib/api'
import { userPasswordValidationMessage } from '../lib/userAdminValidation'

type DialogMode = 'create' | 'edit' | 'password' | 'tombstone'

interface DialogState {
  mode: DialogMode
  user: UserAdminListItem | null
}

interface MutationRequest {
  path: string
  body: Record<string, unknown>
  success: string
}

const PAGE_SIZE = 50

function formatDate(value: string | null): string {
  if (!value) return 'Never'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Unavailable'
    : date.toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
}

function accountActive(user: UserAdminListItem): boolean {
  return user.userStatus === 'active' && user.credentialStatus === 'active'
}

export function UserManagementPage() {
  const client = useQueryClient()
  const [offset, setOffset] = useState(0)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<UserRole>('user')
  const [success, setSuccess] = useState<string | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)

  const query = useQuery({
    queryKey: ['users', offset],
    queryFn: () =>
      getJson<UserAdminListPage>(
        `/api/v1/users?limit=${PAGE_SIZE}&offset=${offset}`,
      ),
  })

  const mutation = useMutation({
    mutationFn: (request: MutationRequest) =>
      postJson<UserAdminChangeResult>(request.path, request.body),
    onSuccess: (_result, request) => {
      setSuccess(request.success)
      closeDialog()
      void client.invalidateQueries({ queryKey: ['users'] })
    },
  })

  function resetFields(): void {
    setUsername('')
    setEmail('')
    setPassword('')
    setRole('user')
    setValidationError(null)
  }

  function closeDialog(): void {
    setDialog(null)
    resetFields()
    mutation.reset()
  }

  function openCreate(): void {
    setSuccess(null)
    resetFields()
    setDialog({ mode: 'create', user: null })
  }

  function openFor(mode: Exclude<DialogMode, 'create'>, user: UserAdminListItem): void {
    setSuccess(null)
    mutation.reset()
    setPassword('')
    setUsername(user.username)
    setEmail(user.email ?? '')
    setRole(user.roles.includes('admin') ? 'admin' : 'user')
    setDialog({ mode, user })
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!dialog) return
    if (dialog.mode === 'create' || dialog.mode === 'password') {
      const passwordError = userPasswordValidationMessage(password, {
        username,
        email,
      })
      if (passwordError) {
        mutation.reset()
        setValidationError(passwordError)
        return
      }
    }
    setValidationError(null)
    const userId = dialog.user?.id
    if (dialog.mode === 'create') {
      mutation.mutate({
        path: '/api/v1/users/create',
        body: { username, email, password, role },
        success: 'User account created.',
      })
      return
    }
    if (!userId) return
    if (dialog.mode === 'edit') {
      mutation.mutate({
        path: '/api/v1/users/update',
        body: { userId, username, email, role },
        success: 'User account updated.',
      })
      return
    }
    if (dialog.mode === 'password') {
      mutation.mutate({
        path: '/api/v1/users/password',
        body: { userId, password },
        success: 'Password reset and active sessions revoked.',
      })
      return
    }
    mutation.mutate({
      path: '/api/v1/users/tombstone',
      body: { userId },
      success: 'User account permanently disabled.',
    })
  }

  function setActivation(user: UserAdminListItem): void {
    const active = accountActive(user)
    setSuccess(null)
    mutation.mutate({
      path: '/api/v1/users/activation',
      body: { userId: user.id, active: !active },
      success: active
        ? 'User account deactivated and active sessions revoked.'
        : 'User account activated.',
    })
  }

  if (query.isLoading) return <LoadingState />
  if (query.error) {
    return <ErrorState error={query.error} retry={() => void query.refetch()} />
  }

  const users = query.data?.users ?? []
  return (
    <div className="user-admin">
      <PageHeader
        eyebrow="Administration"
        title="User management"
        description="Control Kaudit sign-in accounts, access roles, and account status."
        badge={(
          <button className="primary-action" type="button" onClick={openCreate}>
            <Plus size={16} aria-hidden />
            Create user
          </button>
        )}
      />

      {success && <Notice tone="success" title="Change completed">{success}</Notice>}
      {mutation.error && !dialog && (
        <Notice tone="warning" title="Change not completed">
          {mutation.error.message}
        </Notice>
      )}

      <section className="data-table user-table" aria-labelledby="user-list-title">
        <div className="table-heading">
          <div>
            <span className="eyebrow">Access directory</span>
            <h2 id="user-list-title">Login accounts</h2>
          </div>
          <span className="soft-chip">{users.length.toLocaleString('en-IN')} shown</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last login</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr><td className="table-empty" colSpan={5}>No user accounts found.</td></tr>
              ) : users.map((user) => {
                const active = accountActive(user)
                const tombstoned =
                  user.userStatus === 'tombstoned' ||
                  user.credentialStatus === 'tombstoned'
                return (
                  <tr key={user.id}>
                    <td>
                      <strong>{user.displayName || user.username}</strong>
                      <span className="cell-sub">{user.username} · {user.email || 'No email'}</span>
                    </td>
                    <td><span className="role-chip">{user.roles.includes('admin') ? 'Admin' : 'User'}</span></td>
                    <td>
                      <span className={`account-state ${active ? 'active' : tombstoned ? 'tombstoned' : 'disabled'}`}>
                        {active ? 'Active' : tombstoned ? 'Deleted' : 'Inactive'}
                      </span>
                    </td>
                    <td>{formatDate(user.lastLoginAt)}</td>
                    <td>
                      <div className="user-actions">
                        <button type="button" onClick={() => openFor('edit', user)} disabled={tombstoned} aria-label={`Edit ${user.username}`} title="Edit account">
                          <Pencil size={15} aria-hidden />
                        </button>
                        <button type="button" onClick={() => openFor('password', user)} disabled={tombstoned} aria-label={`Reset password for ${user.username}`} title="Reset password">
                          <KeyRound size={15} aria-hidden />
                        </button>
                        <button type="button" onClick={() => setActivation(user)} disabled={tombstoned || mutation.isPending} aria-label={`${active ? 'Deactivate' : 'Activate'} ${user.username}`} title={active ? 'Deactivate account' : 'Activate account'}>
                          {active ? <PowerOff size={15} aria-hidden /> : <Power size={15} aria-hidden />}
                        </button>
                        <button className="danger" type="button" onClick={() => openFor('tombstone', user)} disabled={tombstoned} aria-label={`Delete ${user.username}`} title="Delete account">
                          <Trash2 size={15} aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="table-pagination">
          <span>Rows {users.length === 0 ? 0 : offset + 1}–{offset + users.length}</span>
          <div>
            <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous</button>
            <button type="button" disabled={users.length < PAGE_SIZE} onClick={() => setOffset(offset + PAGE_SIZE)}>Next</button>
          </div>
        </div>
      </section>

      {dialog && (
        <div className="modal-backdrop" role="presentation">
          <section className="user-dialog" role="dialog" aria-modal="true" aria-labelledby="user-dialog-title">
            <header>
              <div>
                {dialog.mode === 'create' ? <UserCog size={20} aria-hidden /> : <ShieldCheck size={20} aria-hidden />}
                <h2 id="user-dialog-title">
                  {dialog.mode === 'create'
                    ? 'Create user'
                    : dialog.mode === 'edit'
                      ? 'Edit user'
                      : dialog.mode === 'password'
                        ? 'Reset password'
                        : 'Delete user'}
                </h2>
              </div>
              <button className="icon-button" type="button" onClick={closeDialog} aria-label="Close" title="Close">
                <X size={18} aria-hidden />
              </button>
            </header>
            <form onSubmit={submit}>
              {(dialog.mode === 'create' || dialog.mode === 'edit') && (
                <div className="user-form-grid">
                  <label>
                    Username
                    <input
                      value={username}
                      onChange={(event) => setUsername(event.target.value.toLowerCase())}
                      minLength={3}
                      maxLength={64}
                      pattern="[a-z0-9](?:(?:[a-z0-9._]|-)*[a-z0-9])?"
                      autoCapitalize="none"
                      autoComplete="off"
                      spellCheck={false}
                      required
                    />
                  </label>
                  <label>
                    Email
                    <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={255} autoComplete="off" required />
                  </label>
                  <label>
                    Role
                    <select value={role} onChange={(event) => setRole(event.target.value as UserRole)}>
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </select>
                  </label>
                </div>
              )}
              {(dialog.mode === 'create' || dialog.mode === 'password') && (
                <label className="password-field">
                  {dialog.mode === 'create' ? 'Password' : 'New password'}
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value)
                      setValidationError(null)
                    }}
                    minLength={12}
                    maxLength={256}
                    autoComplete="new-password"
                    aria-invalid={validationError !== null}
                    required
                  />
                  <small>12+ characters with uppercase, lowercase, number, and symbol; do not include the username or email name.</small>
                </label>
              )}
              {dialog.mode === 'tombstone' && (
                <Notice tone="warning" title="This cannot be reversed">
                  The account will be permanently disabled, its username retired, and all sessions revoked.
                </Notice>
              )}
              {(validationError || mutation.error) && (
                <Notice tone="warning" title="Change not completed">
                  {validationError ?? mutation.error?.message}
                </Notice>
              )}
              <footer>
                <button type="button" className="button neutral" onClick={closeDialog}>Cancel</button>
                <button type="submit" className={dialog.mode === 'tombstone' ? 'button destructive' : 'primary-action'} disabled={mutation.isPending}>
                  {mutation.isPending
                    ? 'Saving…'
                    : dialog.mode === 'tombstone'
                      ? 'Delete user'
                      : 'Save'}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}
    </div>
  )
}
