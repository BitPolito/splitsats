// Phase 2E-F-C: a LOCAL evidence index for unanimous NON-BINDING historic review.
// There is no Nostr kind, debt discharge, ledger release, settlement or wallet call.
// This intentionally never changes _financialReviewRequired.
import { groupAddress } from './group-history.js'
import { historicalAttestationParticipants } from './historical-attestations.js'
import { buildHistoricalDispositionDrafts } from './historical-disposition.js'
import {
  historicalDispositionIntentSummary, historicalDispositionIntentReady,
} from './historical-disposition-intents.js'

const HEX = /^[0-9a-f]{64}$/
const base = (status, detail, required = [], signed = []) => Object.freeze({
  status, detail, required, signed, pending: required.filter(pk => !signed.includes(pk)),
  safeForPayments: false, completeHistory: false, effective: false,
  legalWaiver: false, ledgerMutationAllowed: false,
})

// Finite-state projection of observed signatures. This is review status ONLY;
// it is not a state machine for debt or Lightning money.
export function historicalReviewStatus({ group, drafts, checkpoint, intents = [],
  sourceAudit, decisionAudit, intentAudit, conflict = false, intentConflict = false } = {}) {
  const participants = historicalAttestationParticipants(group) || []
  const summary = historicalDispositionIntentSummary(group, drafts, checkpoint, intents)
  if (conflict || intentConflict || summary.status === 'conflict')
    return base('conflict', 'contradictory-observed-evidence', participants, summary.signed)
  if (summary.status === 'disagreement')
    return base('disagreement', 'different-signed-preferences', participants, summary.signed)
  if (!group || !checkpoint || !Array.isArray(drafts) || drafts.length !== 2 ||
      group._financialReviewRequired !== true || group._revisionStatus !== 'verified')
    return base('unavailable', 'historical-review-unverified', participants, summary.signed)
  if (!historicalDispositionIntentReady(sourceAudit, decisionAudit, intentAudit))
    return base('unsynchronized', 'relay-comparison-not-ready', participants, summary.signed)
  if (summary.status === 'unavailable')
    return base('unavailable', 'drafts-or-revision-invalid', participants, summary.signed)
  if (summary.status !== 'unanimous-review' || !summary.selectedMode)
    return base('pending', 'missing-independent-review', participants, summary.signed)
  return Object.freeze({ ...base('review-recorded', 'unanimous-preference-observed',
    participants, summary.signed), selectedMode: summary.selectedMode })
}

// Recompute both drafts from signed checkpoint evidence BEFORE deriving a
// manifest; never trust a locally mutated draft or a UI-provided hash.
// A hash of observed signed IDs is a reproducible index, NOT proof of global
// completeness, legal consent, transaction authorization or a Nostr signature.
export async function buildHistoricalReviewRecord({ group, snapshot, checkpoint,
  reconciliations = [], sourceAudit, decisionAudit, intents = [], intentAudit,
  conflict = false, intentConflict = false } = {}) {
  const preview = await buildHistoricalDispositionDrafts({ group, snapshot,
    checkpoint, reconciliations, sourceAudit, decisionAudit, conflict })
  const assessment = historicalReviewStatus({ group, drafts: preview.drafts,
    checkpoint, intents, sourceAudit, decisionAudit, intentAudit,
    conflict, intentConflict })
  if (preview.status !== 'ready-for-review' || assessment.status !== 'review-recorded') {
    return Object.freeze({ ...assessment, status: preview.status !== 'ready-for-review' &&
      !['conflict', 'disagreement'].includes(assessment.status)
      ? 'unavailable' : assessment.status,
      detail: preview.status !== 'ready-for-review' &&
        !['conflict', 'disagreement'].includes(assessment.status)
        ? preview.reason : assessment.detail,
      record: null })
  }
  const members = historicalAttestationParticipants(group)
  const selected = preview.drafts.find(d => d.mode === assessment.selectedMode)
  if (!members || !selected || !HEX.test(checkpoint.hash || '') ||
      !HEX.test(selected.draftHash || '') || !globalThis.crypto?.subtle ||
      typeof TextEncoder === 'undefined') {
    return Object.freeze({ ...base('unavailable', 'missing-hash-capability', members || []), record: null })
  }
  const ids = new Map(), byMember = new Map()
  for (const row of intents) {
    if (!row || !HEX.test(row.id || '') || !members.includes(row.member) ||
        !Number.isSafeInteger(row.signedAt) ||
        row.revisionEventId !== group._revisionId ||
        row.checkpointHash !== checkpoint.hash ||
        row.draftHash !== selected.draftHash || row.mode !== selected.mode) {
      return Object.freeze({ ...base('conflict', 'invalid-receipt-evidence', members), record: null })
    }
    const fingerprint = JSON.stringify(row)
    if (ids.has(row.id)) {
      if (ids.get(row.id) !== fingerprint)
        return Object.freeze({ ...base('conflict', 'different-event-envelope', members), record: null })
      continue // one signed event observed on multiple relays
    }
    ids.set(row.id, fingerprint)
    if (byMember.has(row.member))
      return Object.freeze({ ...base('conflict', 'multiple-signatures', members), record: null })
    byMember.set(row.member, row.id)
  }
  if (members.some(member => !byMember.has(member)))
    return Object.freeze({ ...base('pending', 'missing-independent-review', members,
      [...byMember.keys()]), record: null })
  const address = groupAddress(group)
  if (!address) return Object.freeze({ ...base('unavailable', 'missing-group-address', members), record: null })
  const events = members.map(member => Object.freeze([member, byMember.get(member)]))
  const canonical = { version: 1, action: 'index-observed-historical-review-v1',
    address, revisionEventId: group._revisionId, snapshotHash: snapshot.hash,
    checkpointHash: checkpoint.hash, mode: selected.mode, draftHash: selected.draftHash,
    signedEvents: events }
  const digest = await globalThis.crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify(canonical)))
  const recordHash = [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0')).join('')
  const record = Object.freeze({ version: 1, recordHash,
    revisionEventId: canonical.revisionEventId, snapshotHash: canonical.snapshotHash,
    checkpointHash: canonical.checkpointHash, mode: canonical.mode,
    draftHash: canonical.draftHash, signedEvents: Object.freeze(events),
    safeForPayments: false, completeHistory: false, effective: false,
    legalWaiver: false })
  return Object.freeze({ ...assessment, record })
}
