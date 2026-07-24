import type { RawFullDashboard } from '../ui/fullDashboard.ts'

// Representative aggregate-only preview data. It mirrors known row counts where
// available; monetary figures are illustrative and visibly provisional in the UI.
// The live server always reads aggregate values from MySQL.
export const sampleFullRaw: RawFullDashboard = {
  generatedAt: '2026-07-24T12:00:00Z · static preview',
  monitor: {
    calls: 43245, recordingArtifacts: 43245, withSourceUrl: 16371,
    withBaseline: 0, everVerified: 0, evidenceObjects: 43705,
    ingestionBatches: 5, ingestionCompleted: 5, users: null,
    findings: [], generatedAt: '2026-07-24T12:00:00Z',
  },
  quality: {
    auditRuns: 3418, analyzedCalls: 3418, totalFindings: 3748,
    callsWithFindings: 3120, avgConfidence: '0.9021',
    catalogVersion: '2026-07-21.1', catalogStatus: 'calibration',
    confirmations: [{ label: 'candidate', n: 3748 }],
    origins: [{ label: 'model_suggested', n: 3748 }],
    topFindings: [
      { code: 'KQ-004', n: 1400, avgConfidence: '0.9100' },
      { code: 'KQ-001', n: 900, avgConfidence: '0.8800' },
      { code: 'KQ-002', n: 760, avgConfidence: '0.8610' },
      { code: 'KQ-003', n: 688, avgConfidence: '0.8470' },
    ],
  },
  billing: {
    calculations: 43245, calculatedTotal: '80310.00000000',
    billableMinutes: '8453.68421000', currency: 'INR',
    rateCardVersion: '2026-02-28-v1', rateCardStatus: 'draft',
    rateCardApprovedBy: null, rateCardApprovedAt: null,
    reconciliationStatus: 'open', claimedSubtotal: '82450.00000000',
    verifiedSubtotal: '80310.00000000', netVariance: '2140.00000000',
  },
  snapshots: [
    {
      cadence: 'weekly', label: 'Week ending 2026-07-19',
      start: '2026-07-13', end: '2026-07-19', currency: 'INR',
      verified: '18450', vendorClaimed: '19100',
      vendorClaimedBasis: 'provider_claimed_no_invoice',
      priorVerified: '18200', priorVendorClaimed: '18800',
    },
    {
      cadence: 'monthly', label: 'June 2026',
      start: '2026-06-01', end: '2026-06-30', currency: 'INR',
      verified: '80310', vendorClaimed: '82450',
      vendorClaimedBasis: 'invoiced',
      priorVerified: '78900', priorVendorClaimed: '80600',
    },
    {
      cadence: 'quarterly', label: 'Fiscal quarter ending 2026-06-30',
      start: '2026-04-01', end: '2026-06-30', currency: 'INR',
      verified: '231400', vendorClaimed: '238900',
      vendorClaimedBasis: 'provider_claimed_no_invoice',
      priorVerified: '221000', priorVendorClaimed: '227500',
    },
    {
      cadence: 'yearly', label: 'FY 2025–26',
      start: '2025-04-01', end: '2026-03-31', currency: 'INR',
      verified: '912300', vendorClaimed: '946800',
      vendorClaimedBasis: 'provider_claimed_no_invoice',
      priorVerified: null, priorVendorClaimed: null,
    },
  ],
}
