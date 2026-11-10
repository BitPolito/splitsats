// SplitSats 3B-I — independently re-verifiable, PUBLIC Nostr 9604 evidence.
// Nothing in this module has authority over balances, groups, v2 writers or wallets.
// A verifier (nostr-tools.verifyEvent in production) MUST be supplied by caller.
// Client-provided exports and EOSE are not evidence of complete relay history.
import { parseFinancialDestinationConsentEvent } from './financial-destination-consent.js'
import { groupAddress } from './group-history.js'
import { KIND_FINANCIAL_DESTINATION_CONSENT } from './constants.js'

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const FORMAT = 'splitsats-public-signed-destination-evidence-v1'
export const MAX_DESTINATION_EVIDENCE_EVENTS = 200
export const MAX_DESTINATION_EVIDENCE_JSON = 160000
export const DESTINATION_EVIDENCE_FORMAT = FORMAT
const forbidden = Object.freeze({ activationAllowed: false, migrationEffective: false,
  v2WriterEnabled: false, safeForPayments: false, completeHistory: false,
  signedNewGroupCreated: false, balancesTransferred: false, legacyNamespaceRetired: false })
const report = (status, reasons = [], extra = {}) => Object.freeze({
  status, reasons: [...new Set(reasons)].sort(), ...extra, ...forbidden,
})
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x)

// Normalize ONLY the seven public NIP-01 envelope fields. Never export local
// account state, private keys, LNURL invoices, wallet data or cached balances.
function publicEnvelope(event) {
  if (!plain(event) || event.kind !== KIND_FINANCIAL_DESTINATION_CONSENT ||
      !HEX64.test(event.id || '') || !HEX64.test(event.pubkey || '') ||
      !HEX128.test(event.sig || '') ||
      !Number.isSafeInteger(event.created_at) || event.created_at <= 0 ||
      typeof event.content !== 'string' || event.content.length > 2048 ||
      !Array.isArray(event.tags) || event.tags.length > 110 ||
      event.tags.some(t => !Array.isArray(t) || t.length !== 2 ||
        typeof t[0] !== 'string' || typeof t[1] !== 'string' ||
        t[0].length > 32 || t[1].length > 300)) return null
  return { id: event.id, pubkey: event.pubkey, created_at: event.created_at,
    kind: event.kind, tags: event.tags.map(t => [t[0], t[1]]),
    content: event.content, sig: event.sig }
}

// The 3B-H subscription has already called the application parser. This extra
// verification prevents a locally corrupted cache from being exported as proof.
export function rememberSignedDestinationEvidence(existing, event, parsedRow, verifySignature) {
  if (!Array.isArray(existing) || existing.length >= MAX_DESTINATION_EVIDENCE_EVENTS ||
      typeof verifySignature !== 'function' || !parsedRow) {
    return report('conflict', ['invalid-evidence-collector'])
  }
  const copy = publicEnvelope(event)
  if (!copy || copy.id !== parsedRow.id || copy.pubkey !== parsedRow.member ||
      typeof parsedRow.proposalHash !== 'string' ||
      typeof parsedRow.targetGroupAddress !== 'string' ||
      typeof parsedRow.sourceRevisionEventId !== 'string')
    return report('conflict', ['invalid-signed-event'])
  let data
  try { data = JSON.parse(copy.content) } catch { return report('conflict', ['invalid-content']) }
  if (!plain(data) || data.proposalHash !== parsedRow.proposalHash ||
      data.targetGroupAddress !== parsedRow.targetGroupAddress ||
      data.sourceRevisionEventId !== parsedRow.sourceRevisionEventId ||
      data.choice !== parsedRow.choice || event.created_at !== parsedRow.createdAt)
    return report('conflict', ['signed-content-does-not-match-parsed-row'])
  try { if (verifySignature(copy) !== true) return report('conflict', ['signature-invalid']) }
  catch { return report('conflict', ['signature-verification-error']) }
  for (const old of existing) {
    if (old?.id === copy.id) return JSON.stringify(old) === JSON.stringify(copy)
      ? report('unchanged', [], { events: existing })
      : report('conflict', ['same-id-different-envelope'])
  }
  return report('appended', [], { events: [...existing, copy] })
}

function checkBundle(group, draft, bundle, verifySignature) {
  let size
  try { size = JSON.stringify(bundle).length }
  catch { return report('invalid', ['bundle-not-json-serializable']) }
  if (!plain(bundle) || bundle.format !== FORMAT ||
      draft?.status !== 'specific-target-review-only' ||
      bundle.sourceGroupAddress !== groupAddress(group) ||
      bundle.sourceRevisionEventId !== group?._revisionId ||
      bundle.targetGroupAddress !== draft.targetGroupAddress ||
      bundle.proposalHash !== draft.proposalHash ||
      typeof verifySignature !== 'function' ||
      !Array.isArray(bundle.events) ||
      bundle.events.length > MAX_DESTINATION_EVIDENCE_EVENTS ||
      !['matching-observed','pending','divergent','conflict','at-limit','overflow',
        'invalid','unknown'].includes(bundle.reportedRelayStatus) ||
      size > MAX_DESTINATION_EVIDENCE_JSON)
    return report('invalid', ['invalid-or-stale-bundle'])
  const byId = new Map(), signers = new Map(), verified = []
  for (const event of bundle.events) {
    const copy = publicEnvelope(event)
    if (!copy) return report('invalid', ['invalid-public-envelope'])
    try { if (verifySignature(copy) !== true) return report('invalid', ['invalid-schnorr-signature']) }
    catch { return report('invalid', ['signature-verifier-failed']) }
    const row = parseFinancialDestinationConsentEvent(copy, group, draft)
    if (!row) return report('invalid', ['wrong-group-revision-target-or-schema'])
    const canonical = JSON.stringify(copy)
    if (byId.has(row.id)) {
      if (byId.get(row.id) !== canonical) return report('invalid', ['same-id-different-envelope'])
      // Exact duplicate from two relay deliveries is not a second signature.
      continue
    }
    byId.set(row.id, canonical)
    if (signers.has(row.member)) return report('conflict', ['multiple-signatures-from-member'])
    signers.set(row.member, row.choice)
    verified.push(copy)
  }
  verified.sort((a,b) => a.id.localeCompare(b.id))
  return report(verified.length ? 'signature-verified-observation' : 'empty-observation',
    verified.length ? [] : ['empty-signed-event-set-is-not-evidence-of-absence'],
    { events: verified, signedEventIds: verified.map(e => e.id),
      verifiedCount: verified.length, reportedRelayStatus: bundle.reportedRelayStatus })
}

// A portable, public, *untrusted* export. Verification is repeated on import.
// Reported relay status is a local statement, never cryptographically signed.
export function buildFinancialDestinationEvidenceBundle(group, draft, events,
  reportedRelayStatus = 'unknown', verifySignature) {
  const candidate = { format: FORMAT, sourceGroupAddress: groupAddress(group),
    sourceRevisionEventId: group?._revisionId, targetGroupAddress: draft?.targetGroupAddress,
    proposalHash: draft?.proposalHash, reportedRelayStatus, events }
  const checked = checkBundle(group, draft, candidate, verifySignature)
  if (!['signature-verified-observation', 'empty-observation'].includes(checked.status))
    return checked
  return report('exportable-observation', checked.reasons, { bundle: Object.freeze({
    format: FORMAT, sourceGroupAddress: candidate.sourceGroupAddress,
    sourceRevisionEventId: candidate.sourceRevisionEventId,
    targetGroupAddress: candidate.targetGroupAddress, proposalHash: candidate.proposalHash,
    reportedRelayStatus, events: checked.events,
  }), verifiedCount: checked.verifiedCount })
}

export function inspectFinancialDestinationEvidenceBundle(group, draft, bundle, verifySignature) {
  return checkBundle(group, draft, bundle, verifySignature)
}

export function compareFinancialDestinationEvidenceBundles(group, draft,
  localBundle, importedBundle, verifySignature) {
  const local = checkBundle(group, draft, localBundle, verifySignature)
  const imported = checkBundle(group, draft, importedBundle, verifySignature)
  const ok = r => ['signature-verified-observation','empty-observation'].includes(r.status)
  if (!ok(local) || !ok(imported))
    return report('blocked', ['invalid-or-conflicting-signed-evidence', ...local.reasons,
      ...imported.reasons], { localStatus: local.status, importedStatus: imported.status })
  if (!local.verifiedCount || !imported.verifiedCount)
    return report('pending', ['missing-signed-destination-evidence'],
      { localCount: local.verifiedCount, importedCount: imported.verifiedCount })
  // Immutable signed event IDs plus the exact cryptographically verified
  // canonical envelopes must match, not just a member count or proposal hash.
  const a = local.events.map(e => JSON.stringify(e))
  const b = imported.events.map(e => JSON.stringify(e))
  if (JSON.stringify(a) !== JSON.stringify(b))
    return report('divergent', ['verified-signed-event-sets-differ'],
      { localCount: local.verifiedCount, importedCount: imported.verifiedCount,
        localIds: local.signedEventIds, importedIds: imported.signedEventIds })
  if (local.reportedRelayStatus !== 'matching-observed' ||
      imported.reportedRelayStatus !== 'matching-observed')
    return report('pending-relay-observation', ['relay-reports-not-matching-or-not-complete'],
      { verifiedCount: local.verifiedCount })
  return report('matching-verified-events-only',
    ['client-reports-unsigned', 'missing-clients-or-events-still-possible',
      'old-client-retirement-unverified'],
    { verifiedCount: local.verifiedCount, signedEventIds: local.signedEventIds })
}
