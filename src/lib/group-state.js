// Author-scoped, ephemeral *verified* group state.
// Callers may supply only group definitions parsed from signature-verified
// relay events. Cached arrays are deliberately not accepted as evidence.
import { groupAddress } from './group-history.js'
import { isNewerGroupDefinition } from './event-validation.js'

const TRANSACTION_KEYS = ['expenses', 'settlements', 'confirmations']

export function findGroupByRef(groups, ref) {
  if (!Array.isArray(groups) || typeof ref !== 'string' || !ref.startsWith('30001:')) return null
  return groups.find(group => groupAddress(group) === ref) || null
}

export function isLegacyAmbiguous(groups, ref) {
  const group = findGroupByRef(groups, ref)
  return !group || groups.filter(other => other.id === group.id && groupAddress(other)).length !== 1
}

// Merging another signer who uses the same d-tag must never merge group
// snapshots. If the d-tag is now ambiguous, previously seen unscoped legacy
// transactions are removed from both groups; scoped signed events remain.
export function mergeVerifiedGroup(groups, incoming) {
  if (!Array.isArray(groups)) return groups
  const ref = groupAddress(incoming)
  if (!ref || !/^[0-9a-f]{64}$/.test(incoming?.eventId || '') ||
      !Number.isSafeInteger(incoming?._groupCreatedAt) ||
      !Array.isArray(incoming?.members) || !incoming.members.includes(incoming.pubkey)) return groups
  const existing = findGroupByRef(groups, ref)
  if (!isNewerGroupDefinition(existing, incoming)) return groups
  // A new signed revision pointer invalidates ALL previously computed
  // balances until the complete immutable chain has been replayed.
  const revisionChanged = !!existing && (existing._revisionId || null) !== (incoming._revisionId || null)
  const updated = existing
    ? { ...existing, ...incoming,
      expenses: revisionChanged ? [] : existing.expenses || [],
      settlements: revisionChanged ? [] : existing.settlements || [],
      confirmations: revisionChanged ? [] : existing.confirmations || [],
      _revisions: revisionChanged ? [] : existing._revisions || [],
      _revisionStatus: revisionChanged ? (incoming._revisionId ? 'pending' : 'legacy') :
        (existing._revisionStatus || (incoming._revisionId ? 'pending' : 'legacy')),
      _financialReviewRequired: revisionChanged ? false : !!existing._financialReviewRequired,
      _financialMigrationQuarantine: revisionChanged ? false : !!existing._financialMigrationQuarantine,
      _financialNamespaceRisk: revisionChanged ? null : existing._financialNamespaceRisk || null,
      _migrationReviewRows: revisionChanged ? [] : existing._migrationReviewRows || [],
      _migrationReviewAudit: revisionChanged ? null : existing._migrationReviewAudit || null,
      _migrationReviewConflict: revisionChanged ? false : !!existing._migrationReviewConflict,
      _destinationConsentRows: revisionChanged ? [] : existing._destinationConsentRows || [],
      _destinationConsentAudit: revisionChanged ? null : existing._destinationConsentAudit || null,
      _destinationConsentConflict: revisionChanged ? false : !!existing._destinationConsentConflict,
      _destinationConsentDraftHash: revisionChanged ? null : existing._destinationConsentDraftHash || null,
      _destinationSignedEvidence: revisionChanged ? [] : existing._destinationSignedEvidence || [],
      proposedExpenses: revisionChanged ? [] : existing.proposedExpenses || [],
      _expenseDecisions: revisionChanged ? [] : existing._expenseDecisions || [],
      _cancellationDecisions: revisionChanged ? [] : existing._cancellationDecisions || [],
      _expenseReviewRequired: revisionChanged ? false : !!existing._expenseReviewRequired,
      _financialHistoryChecked: revisionChanged ? false : !!existing._financialHistoryChecked,
      _expensePolicy: revisionChanged ? null : existing._expensePolicy || null,
      _memberExitRequests: revisionChanged ? [] : existing._memberExitRequests || [],
      _memberExitStatus: revisionChanged ? 'pending' : existing._memberExitStatus || 'none',
      _historicalActivityDetected: revisionChanged ? false : !!existing._historicalActivityDetected,
      _priorHistoryChecked: revisionChanged ? false : !!existing._priorHistoryChecked,
      _priorFinancialEvidence: revisionChanged ? [] : existing._priorFinancialEvidence || [],
      _priorEvidenceOverflow: revisionChanged ? false : !!existing._priorEvidenceOverflow,
      _priorReplayEvents: revisionChanged ? [] : existing._priorReplayEvents || [],
      _priorReplayOverflow: revisionChanged ? false : !!existing._priorReplayOverflow,
      _priorRelayAudit: revisionChanged ? null : existing._priorRelayAudit || null,
      _historicalSnapshot: revisionChanged ? null : existing._historicalSnapshot || null,
      _historicalAttestations: revisionChanged ? [] : existing._historicalAttestations || [],
      _historicalAttestationConflict: revisionChanged ? false : !!existing._historicalAttestationConflict }
    : { ...incoming, expenses: [], settlements: [], confirmations: [], _synced: false,
      _revisions: [], _revisionStatus: incoming._revisionId ? 'pending' : 'legacy',
      _financialReviewRequired: false, _financialMigrationQuarantine: false,
      _financialNamespaceRisk: null, _migrationReviewRows: [],
      _migrationReviewAudit: null, _migrationReviewConflict: false, _destinationConsentRows: [], _destinationConsentAudit: null,
      _destinationConsentConflict: false, _destinationConsentDraftHash: null,
      _destinationSignedEvidence: [], proposedExpenses: [],
      _expenseDecisions: [], _cancellationDecisions: [], _expenseReviewRequired: false,
      _priorHistoryChecked: false,
      _priorFinancialEvidence: [], _priorEvidenceOverflow: false,
      _priorReplayEvents: [], _priorReplayOverflow: false,
      _priorRelayAudit: null,
      _historicalSnapshot: null, _historicalAttestations: [],
      _historicalAttestationConflict: false,
      _memberExitRequests: [], _memberExitStatus: 'none', _historicalActivityDetected: false,
      _financialHistoryChecked: false,
      _expensePolicy: incoming._expensePolicy || null }
  let next = existing
    ? groups.map(group => groupAddress(group) === ref ? updated : group)
    : [...groups, updated]
  if (next.filter(group => group.id === incoming.id).length > 1) {
    next = next.map(group => {
      if (group.id !== incoming.id) return group
      const stripped = { ...group, _legacyQuarantined: true }
      for (const key of TRANSACTION_KEYS) {
        stripped[key] = (group[key] || []).filter(item => item._legacyUnscoped !== true)
      }
      return stripped
    })
  }
  return next
}

export function mayApplyGroupTransaction(groups, ref, transaction) {
  const group = findGroupByRef(groups, ref)
  if (!group || group._financialMigrationQuarantine || !transaction ||
      typeof transaction !== 'object') return false
  return transaction._legacyUnscoped !== true || !isLegacyAmbiguous(groups, ref)
}
