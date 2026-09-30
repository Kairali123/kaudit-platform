import type { PageSnapshotStore } from '../adapters/mysqlPageSnapshot.ts'

/**
 * Audit Monitor month summaries served from stored snapshots.
 *
 * The page reads the last stored result (one row). Recomputing happens only on
 * `refresh=1`, which Vercel routes to a dedicated long-running function, so the
 * heavy month-wide aggregates never run inside the 30 s page function and never
 * stack up behind each other (one refresh per key at a time).
 */
export const AUDIT_MONITOR_SNAPSHOT_DEFINITION = 'audit-monitor-summary/1'
/** Served by the dedicated long function on Vercel; an alias locally. */
export const AUDIT_MONITOR_REFRESH_ROUTE = '/api/v1/audits/refresh'
export const AUDIT_MONITOR_REFRESH_LEASE_SECONDS = 300

export interface SnapshotMeta {
  computedAt: string | null
  refreshing: boolean
  missing?: true
}

/**
 * The stored-snapshot key, or null when this read must stay live: a filtered
 * view (category or Task ID) covers far fewer rows and is not cached.
 */
export function auditMonitorSnapshotKey(options: {
  section: string
  month: string | null
  category: string | null
  taskId: string | null
}): string | null {
  if (!options.section.startsWith('summary-')) return null
  if (!options.month || options.category || options.taskId) return null
  return `audit-monitor:${options.section}:${options.month}`
}

export async function snapshotSummary(options: {
  store: PageSnapshotStore
  key: string
  refresh: boolean
  compute: () => Promise<Record<string, unknown>>
}): Promise<Record<string, unknown> & { snapshot: SnapshotMeta }> {
  const { store, key } = options
  const stored = async (refreshing: boolean) => {
    const snapshot = await store.read(key, AUDIT_MONITOR_SNAPSHOT_DEFINITION)
    return snapshot
      ? {
          ...(snapshot.payload as Record<string, unknown>),
          generatedAt: snapshot.computedAt,
          snapshot: {
            computedAt: snapshot.computedAt,
            refreshing: refreshing || snapshot.refreshing,
          },
        }
      : { snapshot: { computedAt: null, refreshing, missing: true as const } }
  }
  if (!options.refresh) return stored(false)
  if (!(await store.claimRefresh(key, AUDIT_MONITOR_REFRESH_LEASE_SECONDS))) {
    // Another refresh of this key is running: answer with what is stored.
    return stored(true)
  }
  let fresh: Record<string, unknown>
  try {
    fresh = await options.compute()
  } catch (error) {
    await store.release(key)
    throw error
  }
  await store.write(key, AUDIT_MONITOR_SNAPSHOT_DEFINITION, fresh)
  const computedAt =
    typeof fresh.generatedAt === 'string' ? fresh.generatedAt : new Date().toISOString()
  return { ...fresh, snapshot: { computedAt, refreshing: false } }
}
