import { classifyEligibility, hasAuditableTranscript } from './eligibility.ts'
import { extractTaskId } from './taskId.ts'
import {
  KSERVE_AI_CALLER,
  type CallAuditDisplay,
  type CallAuditSourceRow,
} from './types.ts'

/**
 * Projects a source row into the only shape that may leave the server.
 *
 * Every field is copied explicitly — never spread — so a new sensitive column
 * on {@link CallAuditSourceRow} cannot leak into a display payload by default.
 * The full `leadId` stays server-side; only its derived Task ID is surfaced.
 */
export function toCallAuditDisplay(
  row: CallAuditSourceRow,
): CallAuditDisplay {
  return {
    callId: row.callId,
    calledAt: row.calledAt,
    durationSeconds: row.durationSeconds,
    taskId: extractTaskId(row.leadId),
    caller: KSERVE_AI_CALLER,
    eligibility: classifyEligibility(row.transcript).eligibility,
    hasTranscript: hasAuditableTranscript(row.transcript),
  }
}
