// Phase 2E-F-A: read-only historical financial disposition drafts.
// These are LOCAL PREVIEWS, not signed Nostr events, debts or receipts.
// Never apply the suggested vector to a current group or wallet.
import { groupAddress } from './group-history.js'
import { historicalAttestationParticipants } from './historical-attestations.js'
import {
  historicalReconciliationSummary, historicalReconciliationConflicts,
  reconciliationRelayReady,
} from './historical-reconciliation.js'

const HEX = /^[0-9a-f]{64}$/
const MAX_SATS = 2_100_000_000_000_000
const MODES = Object.freeze(['retain-historical-record', 'propose-mutual-waiver'])
const unavailable = reason => Object.freeze({ status: 'unavailable', reason,
  drafts: [], safeForPayments: false, completeHistory: false, effective: false })

function originalVector(checkpoint, participants) {
  if (!Array.isArray(checkpoint?.proposedNet) || checkpoint.proposedNet.length !== participants.length) return null
  const vector = []
  let sum = 0
  for (let i = 0; i < participants.length; i++) {
    const row = checkpoint.proposedNet[i]
    if (!Array.isArray(row) || row.length !== 2 || row[0] !== participants[i] ||
        !Number.isSafeInteger(row[1]) || Math.abs(row[1]) > MAX_SATS) return null
    sum += row[1]
    if (!Number.isSafeInteger(sum)) return null
    vector.push([row[0], row[1]])
  }
  return sum === 0 ? vector : null
}

async function digestHex(canonical) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') return null
  const bytes = await globalThis.crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(JSON.stringify(canonical)))
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// All arguments originate from signature-verified Nostr subscribers and the
// existing read-only replay. The caller must never use the result to unlock.
export async function buildHistoricalDispositionDrafts({
  group, snapshot, checkpoint, reconciliations = [], sourceAudit,
  decisionAudit, conflict = false,
} = {}) {
  const participants = historicalAttestationParticipants(group)
  const address = groupAddress(group)
  if (!participants || !address || group?._revisionStatus !== 'verified' ||
      group?._financialReviewRequired !== true || group?._priorHistoryChecked !== true ||
      !group?._historicalActivityDetected || group?._reconciliationDecisionsChecked !== true ||
      group?._priorEvidenceOverflow || group?._priorReplayOverflow ||
      group?._historicalAttestationConflict || group?._reconciliationConflict || conflict) {
    return unavailable('unverified-historical-state')
  }
  if (!reconciliationRelayReady(sourceAudit) || !reconciliationRelayReady(decisionAudit))
    return unavailable('relay-snapshots-not-matching')
  if (!HEX.test(snapshot?.hash || '') || !HEX.test(checkpoint?.hash || '') ||
      checkpoint?.snapshotHash !== snapshot.hash ||
      snapshot.revisionEventId !== group._revisionId ||
      checkpoint.revisionEventId !== group._revisionId ||
      checkpoint.safeForPayments !== false || checkpoint.completeHistory !== false ||
      JSON.stringify(checkpoint.participants) !== JSON.stringify(participants)) {
    return unavailable('missing-or-stale-checkpoint')
  }
  if (historicalReconciliationSummary(group, checkpoint, reconciliations).status !== 'agreed' ||
      historicalReconciliationConflicts(group, checkpoint, reconciliations).status !== 'agreed') {
    return unavailable('unanimous-reconciliation-not-established')
  }
  const original = originalVector(checkpoint, participants)
  if (!original) return unavailable('invalid-historical-net-vector')
  if (!globalThis.crypto?.subtle || typeof TextEncoder === 'undefined')
    return unavailable('hashing-not-available')
  // Reconstruct the exact 2E-E-A canonical commitment before previewing any
  // amounts: a locally mutated net vector must not borrow a signed hash.
  const committedHash = await digestHex({ version: 1,
    action: 'acknowledge-reconciliation-v1', address,
    revisionEventId: group._revisionId, snapshotHash: snapshot.hash,
    participants, proposedNet: original })
  if (committedHash !== checkpoint.hash)
    return unavailable('checkpoint-net-hash-mismatch')

  const drafts = []
  for (const mode of MODES) {
    const proposed = mode === 'retain-historical-record'
      ? original.map(([pk, sats]) => [pk, sats])
      : original.map(([pk]) => [pk, 0])
    const canonical = { version: 1, action: 'draft-historical-disposition-v1',
      mode, address, revisionEventId: group._revisionId, snapshotHash: snapshot.hash,
      reconciliationCheckpointHash: checkpoint.hash, participants,
      historicalNet: original, proposedNet: proposed }
    const draftHash = await digestHex(canonical)
    if (!draftHash) return unavailable('hashing-not-available')
    // Immutable display-only data. Do not persist this as an executable transfer.
    const historicalNet = Object.freeze(original.map(row => Object.freeze([...row])))
    const proposedNet = Object.freeze(proposed.map(row => Object.freeze([...row])))
    drafts.push(Object.freeze({ mode, draftHash, revisionEventId: group._revisionId,
      historicalNet, proposedNet, participantCount: participants.length,
      requiresIndependentAgreement: true, effective: false,
      safeForPayments: false, completeHistory: false }))
  }
  return Object.freeze({ status: 'ready-for-review', reason: null,
    drafts: Object.freeze(drafts), safeForPayments: false, completeHistory: false,
    effective: false })
}
