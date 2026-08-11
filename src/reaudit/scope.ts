export class AuditScopeError extends Error {
  readonly code = 'INVALID_AUDIT_SCOPE'
}

export function normalizeTaskIdScope(values: readonly unknown[]): string[] {
  if (values.length === 0) {
    throw new AuditScopeError('Audit scope must contain at least one task ID')
  }
  if (values.length > 10_000) {
    throw new AuditScopeError('Audit scope cannot contain more than 10,000 task IDs')
  }
  const normalized = values.map((value, index) => {
    if (typeof value !== 'string') {
      throw new AuditScopeError(`Audit scope task ID ${index + 1} must be a string`)
    }
    const taskId = value.trim()
    if (!taskId || taskId.length > 191 || /[\u0000-\u001f\u007f]/.test(taskId)) {
      throw new AuditScopeError(
        `Audit scope task ID ${index + 1} is empty, too long, or contains control characters`,
      )
    }
    return taskId
  })
  if (new Set(normalized).size !== normalized.length) {
    throw new AuditScopeError('Audit scope contains duplicate task IDs')
  }
  return normalized
}

export function parseRecordingBackedTaskIds(text: string): string[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new AuditScopeError('Audit scope file is not valid JSON')
  }
  if (!value || typeof value !== 'object') {
    throw new AuditScopeError('Audit scope file must contain a JSON object')
  }
  const target = (value as { target?: unknown }).target
  if (!target || typeof target !== 'object') {
    throw new AuditScopeError('Audit scope file is missing target')
  }
  const taskIds = (target as { recordingBackedTaskIds?: unknown })
    .recordingBackedTaskIds
  if (!Array.isArray(taskIds)) {
    throw new AuditScopeError(
      'Audit scope file is missing target.recordingBackedTaskIds',
    )
  }
  return normalizeTaskIdScope(taskIds)
}
