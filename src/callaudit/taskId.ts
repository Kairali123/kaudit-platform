/**
 * The Task ID is the final hyphen-separated segment of `lead_id`.
 *
 * Returns null when there is no usable Task ID: a null/undefined lead ID, a
 * blank lead ID, or a lead ID whose final segment is empty after trimming.
 */
export function extractTaskId(leadId: string | null | undefined): string | null {
  if (typeof leadId !== 'string') {
    return null
  }
  const trimmed = leadId.trim()
  if (!trimmed) {
    return null
  }
  const segments = trimmed.split('-')
  const taskId = segments[segments.length - 1].trim()
  return taskId ? taskId : null
}
