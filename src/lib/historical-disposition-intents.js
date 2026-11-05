// Phase 2E-F-B: signed, NON-EFFECTIVE preferences about a historical disposition.
// These signatures record review of a specific 2E-F-A draft. They are neither
// waivers nor receipts, and can NEVER release debts, balances or wallet actions.
// All incoming event envelopes MUST be Schnorr-verified by RelayPool first.
import { groupAddress } from './group-history.js'
import { historicalAttestationParticipants } from './historical-attestations.js'
import { reconciliationRelayReady } from './historical-reconciliation.js'
import { KIND_HISTORICAL_DISPOSITION_INTENT } from './constants.js'

const HEX = /^[0-9a-f]{64}$/
const MODES = new Set(['retain-historical-record', 'propose-mutual-waiver'])
const KEYS = ['action', 'checkpointHash', 'draftHash', 'groupId', 'mode', 'revisionEventId', 'version']
const now = () => Math.floor(Date.now() / 1000)
export const MAX_HISTORICAL_DISPOSITION_INTENTS = 200

const safe = (status, required = [], signed = [], reasons = []) => ({
  status, required, signed, pending: required.filter(m => !signed.includes(m)),
  reasons, safeForPayments: false, completeHistory: false, effective: false,
})

function validDrafts(group, drafts) {
  const members = historicalAttestationParticipants(group)
  if (!members || !Array.isArray(drafts) || drafts.length !== 2 ||
      group?._revisionStatus !== 'verified') return null
  const byMode = new Map()
  for (const d of drafts) {
    if (!d || !MODES.has(d.mode) || byMode.has(d.mode) ||
        !HEX.test(d.draftHash || '') || d.revisionEventId !== group._revisionId ||
        d.effective !== false || d.safeForPayments !== false ||
        d.completeHistory !== false || d.requiresIndependentAgreement !== true ||
        d.participantCount !== members.length) return null
    byMode.set(d.mode, d)
  }
  return byMode.size === 2 ? { members, byMode } : null
}

export function historicalDispositionIntentTags(group, draft, members) {
  const participants = historicalAttestationParticipants(group)
  if (!participants || !groupAddress(group) || !draft || !MODES.has(draft.mode) ||
      !HEX.test(draft.draftHash || '') || draft.revisionEventId !== group._revisionId ||
      JSON.stringify(participants) !== JSON.stringify(members)) {
    throw new Error('Preferenza storica non valida')
  }
  return [['g', group.id], ['a', groupAddress(group)], ['r', group._revisionId],
    ['x', draft.draftHash], ['t', 'splitsats'], ...participants.map(pk => ['p', pk])]
}

function one(tags, key) {
  const rows = tags.filter(t => t[0] === key)
  return rows.length === 1 ? rows[0][1] : null
}

// Parsing does not depend on the *current* draft, so competing signed intents
// are retained as evidence rather than silently discarded.
export function parseHistoricalDispositionIntentEvent(event, group) {
  const members = historicalAttestationParticipants(group)
  if (!members || !groupAddress(group) || group._revisionStatus !== 'verified' ||
      event?.kind !== KIND_HISTORICAL_DISPOSITION_INTENT || !HEX.test(event.id || '') ||
      !members.includes(event.pubkey) || !Number.isSafeInteger(event.created_at) ||
      event.created_at < group._revisions.at(-1).createdAt ||
      event.created_at > now() + 300 || typeof event.content !== 'string' ||
      event.content.length > 1024 || !Array.isArray(event.tags) ||
      event.tags.length !== members.length + 5 ||
      event.tags.some(tag => !Array.isArray(tag) || tag.length !== 2 ||
        typeof tag[0] !== 'string' || typeof tag[1] !== 'string' || tag[1].length > 256) ||
      one(event.tags, 'g') !== group.id || one(event.tags, 'a') !== groupAddress(group) ||
      one(event.tags, 'r') !== group._revisionId || one(event.tags, 't') !== 'splitsats') return null
  const taggedMembers = event.tags.filter(tag => tag[0] === 'p').map(tag => tag[1])
  if (taggedMembers.length !== members.length ||
      new Set(taggedMembers).size !== members.length ||
      taggedMembers.some(pk => !members.includes(pk))) return null
  let body
  try { body = JSON.parse(event.content) } catch { return null }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(KEYS) ||
      body.action !== 'review-historical-disposition-v1' || body.version !== 1 ||
      body.groupId !== group.id || body.revisionEventId !== group._revisionId ||
      !MODES.has(body.mode) || !HEX.test(body.checkpointHash || '') ||
      !HEX.test(body.draftHash || '') || one(event.tags, 'x') !== body.draftHash) return null
  return { id: event.id, member: event.pubkey, signedAt: event.created_at,
    revisionEventId: body.revisionEventId, checkpointHash: body.checkpointHash,
    mode: body.mode, draftHash: body.draftHash }
}

export function historicalDispositionIntentSummary(group, drafts, checkpoint, rows = []) {
  const candidates = validDrafts(group, drafts)
  const members = candidates?.members || historicalAttestationParticipants(group) || []
  if (!Array.isArray(rows) || rows.length > MAX_HISTORICAL_DISPOSITION_INTENTS)
    return safe('conflict', members, [], ['over-limit'])
  const seenIds = new Map(), bySigner = new Map(), reasons = new Set()
  for (const row of rows) {
    if (!row || !HEX.test(row.id || '') || !members.includes(row.member) ||
        !HEX.test(row.checkpointHash || '') || !HEX.test(row.draftHash || '') ||
        !MODES.has(row.mode) || row.revisionEventId !== group?._revisionId ||
        !Number.isSafeInteger(row.signedAt)) { reasons.add('invalid-evidence'); continue }
    const fingerprint = JSON.stringify(row)
    if (seenIds.has(row.id)) {
      if (seenIds.get(row.id) !== fingerprint) reasons.add('same-id-conflict')
      continue
    }
    seenIds.set(row.id, fingerprint)
    if (bySigner.has(row.member)) reasons.add('multiple-signatures')
    bySigner.set(row.member, row)
    if (candidates && (!checkpoint || row.checkpointHash !== checkpoint.hash ||
        candidates.byMode.get(row.mode)?.draftHash !== row.draftHash)) {
      reasons.add('alternative-draft')
    }
  }
  const signed = members.filter(pk => bySigner.has(pk))
  if (reasons.size) return safe('conflict', members, signed, [...reasons].sort())
  if (!candidates || !checkpoint || !HEX.test(checkpoint.hash || '') ||
      checkpoint.revisionEventId !== group?._revisionId) return safe('unavailable', members, signed)
  const selections = [...new Set([...bySigner.values()].map(row => row.mode))]
  if (selections.length > 1) return safe('disagreement', members, signed, ['different-preferences'])
  const base = safe(signed.length === members.length ? 'unanimous-review' : 'pending', members, signed)
  return { ...base, selectedMode: selections.length ? selections[0] : null }
}

// Readiness is deliberately stronger than observed votes; still does NOT
// demonstrate global completeness or grant authority to alter financial data.
export function historicalDispositionIntentReady(sourceAudit, decisionAudit, intentAudit) {
  return reconciliationRelayReady(sourceAudit) &&
    reconciliationRelayReady(decisionAudit) && reconciliationRelayReady(intentAudit)
}
