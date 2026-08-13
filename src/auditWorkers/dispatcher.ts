import { ConfigurationError } from '../config/runtime.ts'
import { parseAuditSystem, type AuditSystem } from './control.ts'

const WORKFLOW_FILE = 'audit-worker.yml'
const DISPATCH_TIMEOUT_MS = 10_000
const CONTROL_MODE_VARIABLE = 'KAUDIT_AUDIT_WORKER_CONTROL_MODE'

export interface AuditWorkerDispatcher {
  dispatch(system: AuditSystem): Promise<void>
}

export class AuditWorkerDispatchError extends Error {
  readonly code = 'AUDIT_WORKER_DISPATCH_FAILED'
  readonly status = 503

  constructor() {
    super('Audit worker could not be started')
  }
}

interface GitHubDispatcherConfig {
  repository: string
  ref: string
  token: string
}

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true'
}

function controlMode(
  env: NodeJS.ProcessEnv,
): 'disabled' | 'github' | 'persistent' {
  const value = env[CONTROL_MODE_VARIABLE]?.trim().toLowerCase()
  if (!value) {
    return enabled(env.KAUDIT_GITHUB_WORKER_ENABLED) ? 'github' : 'disabled'
  }
  if (value === 'disabled' || value === 'github' || value === 'persistent') {
    return value
  }
  throw new ConfigurationError(
    'Audit worker control mode must be disabled, github, or persistent',
  )
}

function githubConfig(env: NodeJS.ProcessEnv): GitHubDispatcherConfig {

  const repository = env.KAUDIT_GITHUB_WORKER_REPOSITORY?.trim() || ''
  const ref = env.KAUDIT_GITHUB_WORKER_REF?.trim() || ''
  const token = env.KAUDIT_GITHUB_WORKER_TOKEN?.trim() || ''
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[A-Za-z0-9._\/-]{1,200}$/.test(ref) ||
    ref.includes('..') ||
    !token ||
    token.length > 1024 ||
    /\s/.test(token)
  ) {
    throw new ConfigurationError(
      'GitHub audit worker dispatch configuration is incomplete',
    )
  }
  return { repository, ref, token }
}

/**
 * Creates the dashboard's narrow worker-control edge.
 *
 * Persistent mode is an intentionally empty wake operation: independently
 * supervised workers are already polling durable MySQL intent. GitHub mode
 * preserves the bounded workflow-dispatch fallback. Provider response bodies
 * are deliberately never read.
 */
export function createGitHubActionsAuditWorkerDispatcher(
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
): AuditWorkerDispatcher | undefined {
  const mode = controlMode(env)
  if (mode === 'disabled') return undefined
  if (mode === 'persistent') {
    return {
      async dispatch(system) {
        parseAuditSystem(system)
      },
    }
  }
  const config = githubConfig(env)

  return {
    async dispatch(system) {
      const parsed = parseAuditSystem(system)
      try {
        const response = await fetcher(
          `https://api.github.com/repos/${config.repository}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
            headers: {
              accept: 'application/vnd.github+json',
              authorization: `Bearer ${config.token}`,
              'content-type': 'application/json',
              'user-agent': 'kaudit-platform',
              'x-github-api-version': '2022-11-28',
            },
            body: JSON.stringify({
              ref: config.ref,
              inputs: { system: parsed },
            }),
          },
        )
        if (response.status !== 200 && response.status !== 204) {
          throw new AuditWorkerDispatchError()
        }
      } catch (error) {
        if (error instanceof AuditWorkerDispatchError) throw error
        throw new AuditWorkerDispatchError()
      }
    },
  }
}
