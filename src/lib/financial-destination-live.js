// Phase 3B-H: pure admission for an explicit, public 9604 review signature.
// Signing a destination preference can NEVER authorize new groups, v2 writes,
// balance migrations, debt release or Lightning transactions.
import { canReviewFinancialMigration } from './financial-migration-intents.js'
import { financialDestinationConsentSummary } from './financial-destination-consent.js'

const HEX = /^[0-9a-f]{64}$/

export function canSignFinancialDestinationConsent(group, draft, account, outboxEntries) {
  if (!group || !draft || draft.status !== 'specific-target-review-only' ||
      !HEX.test(account || '') || !group.members?.includes(account) ||
      !Array.isArray(outboxEntries) || outboxEntries.length > 0 ||
      group._migrationReviewConflict ||
      group._migrationReviewAudit?.status !== 'matching-observed' ||
      group._destinationConsentConflict ||
      group._destinationConsentDraftHash !== draft.proposalHash ||
      group._destinationConsentAudit?.status !== 'matching-observed' ||
      draft.sourceRevisionEventId !== group._revisionId ||
      !canReviewFinancialMigration(group, outboxEntries)) return false
  const summary = financialDestinationConsentSummary(group, draft,
    group._destinationConsentRows || [], group._destinationConsentAudit,
    group._destinationConsentConflict)
  return summary.status === 'pending' && summary.pendingMembers.includes(account) &&
    summary.activationAllowed === false && summary.v2WriterEnabled === false
}

// A publication result is an immutable event ID, never permission to execute
// financial actions. The actual signed event must be checked against the
// current draft by parseFinancialDestinationConsentEvent before local display.
export function nonExecutingDestinationReceipt(eventId) {
  if (!HEX.test(eventId || '')) return null
  return Object.freeze({ eventId, status: 'published-review-only',
    activationAllowed: false, migrationEffective: false,
    v2WriterEnabled: false, signedNewGroupCreated: false,
    balancesTransferred: false, legacyNamespaceRetired: false,
    safeForPayments: false, completeHistory: false })
}
