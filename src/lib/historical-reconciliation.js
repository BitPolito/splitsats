// Phase 2E-E-A: participants explicitly acknowledge the same proposed historic
// net vector. These signatures are NOT payment receipts or ledger finality.
// Incoming events must be Schnorr signature-verified by RelayPool first.
import { groupAddress } from './group-history.js'
import { historicalAttestationParticipants, historicalAttestationSummary } from './historical-attestations.js'
import { KIND_HISTORICAL_RECONCILIATION } from './constants.js'

const HEX = /^[0-9a-f]{64}$/
const SAT_LIMIT = 2_100_000_000_000_000
const now = () => Math.floor(Date.now() / 1000)
const FIELDS = ['action', 'checkpointHash', 'groupId', 'revisionEventId', 'snapshotHash', 'version']
export const MAX_HISTORICAL_RECONCILIATIONS = 200

// Only a matching *observed* per-relay snapshot can be proposed for review.
// Even this does not certify completeness, as all relays may omit the same data.
export function reconciliationRelayReady(audit) {
  return audit?.status === 'matching-observed' && audit.allEose === true &&
    Number.isSafeInteger(audit.configuredRelays) && audit.configuredRelays >= 2 &&
    audit.completedRelays === audit.configuredRelays &&
    audit.safeForPayments === false && audit.completeHistory === false &&
    audit.relays?.length === audit.configuredRelays &&
    audit.relays.every(r => r.eose === true && r.phase === 'eose' &&
      !r.overflow && !r.saturated && !r.conflict && !r.lateEvents &&
      r.notObservedCount === 0)
}

// Builds an independently hash-bound draft. It does NOT mutate group balances.
// Every historical participant must have attested to the *source snapshot*
// separately before this proposal is available for explicit acknowledgment.
export async function buildHistoricalReconciliationCheckpoint(group, snapshot, replay, audit, attestations) {
  const members = historicalAttestationParticipants(group)
  if (!members || group?._revisionStatus !== 'verified' ||
      group?._financialReviewRequired !== true ||
      group?._priorHistoryChecked !== true || group?._reconciliationDecisionsChecked !== true ||
      !group?._historicalActivityDetected ||
      group?._priorEvidenceOverflow || group?._priorReplayOverflow ||
      group?._historicalAttestationConflict ||
      !reconciliationRelayReady(audit) ||
      !HEX.test(snapshot?.hash || '') || snapshot?.revisionEventId !== group._revisionId ||
      JSON.stringify(snapshot.participants) !== JSON.stringify(members) ||
      historicalAttestationSummary(group, snapshot, attestations).status !== 'attested' ||
      replay?.status !== 'observed' || replay?.safeForPayments !== false ||
      !replay.observedNet || typeof replay.observedNet !== 'object' ||
      Object.keys(replay.observedNet).length !== members.length ||
      Object.keys(replay.observedNet).some(pk => !members.includes(pk))) return null

  const net = []
  let sum = 0
  for (const pk of members) {
    const amount = replay.observedNet[pk]
    if (!Number.isSafeInteger(amount) || Math.abs(amount) > SAT_LIMIT) return null
    sum += amount
    if (!Number.isSafeInteger(sum)) return null
    net.push([pk, amount])
  }
  if (sum !== 0 || !globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') return null
  const address = groupAddress(group)
  if (!address) return null
  const canonical = JSON.stringify({ version: 1, action: 'acknowledge-reconciliation-v1',
    address, revisionEventId: group._revisionId, snapshotHash: snapshot.hash,
    participants: members, proposedNet: net })
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
  return Object.freeze({ hash, snapshotHash: snapshot.hash, revisionEventId: group._revisionId,
    participants: members, proposedNet: net, safeForPayments: false,
    completeHistory: false })
}

export function historicalReconciliationTags(group, checkpoint) {
  const members = historicalAttestationParticipants(group)
  if (!members || !groupAddress(group) || !HEX.test(checkpoint?.hash || '') ||
      !HEX.test(checkpoint.snapshotHash || '') ||
      checkpoint.revisionEventId !== group._revisionId ||
      JSON.stringify(checkpoint.participants) !== JSON.stringify(members)) {
    throw new Error('Checkpoint di riconciliazione non valido')
  }
  return [['g', group.id], ['a', groupAddress(group)], ['r', group._revisionId],
    ['x', checkpoint.hash], ['t', 'splitsats'], ...members.map(pk => ['p', pk])]
}

function singleTag(tags, key) {
  const found = tags.filter(t => t[0] === key)
  return found.length === 1 ? found[0][1] : null
}

export function parseHistoricalReconciliationEvent(event, group) {
  const members = historicalAttestationParticipants(group)
  if (!members || !groupAddress(group) || group._revisionStatus !== 'verified' ||
      event?.kind !== KIND_HISTORICAL_RECONCILIATION ||
      !HEX.test(event.id || '') || !members.includes(event.pubkey) ||
      !Number.isSafeInteger(event.created_at) ||
      event.created_at < group._revisions.at(-1).createdAt ||
      event.created_at > now() + 300 ||
      typeof event.content !== 'string' || event.content.length > 768 ||
      !Array.isArray(event.tags) || event.tags.length !== members.length + 5 ||
      event.tags.some(t => !Array.isArray(t) || t.length !== 2 ||
        typeof t[0] !== 'string' || typeof t[1] !== 'string' || t[1].length > 256) ||
      singleTag(event.tags, 'g') !== group.id ||
      singleTag(event.tags, 'a') !== groupAddress(group) ||
      singleTag(event.tags, 'r') !== group._revisionId ||
      singleTag(event.tags, 't') !== 'splitsats') return null
  const p = event.tags.filter(t => t[0] === 'p').map(t => t[1])
  if (p.length !== members.length || new Set(p).size !== p.length ||
      p.some(pk => !members.includes(pk))) return null
  let body
  try { body = JSON.parse(event.content) } catch { return null }
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(FIELDS) ||
      body.version !== 1 || body.action !== 'acknowledge-reconciliation-v1' ||
      body.groupId !== group.id || body.revisionEventId !== group._revisionId ||
      !HEX.test(body.snapshotHash || '') || !HEX.test(body.checkpointHash || '') ||
      singleTag(event.tags, 'x') !== body.checkpointHash) return null
  return { id: event.id, member: event.pubkey, revisionEventId: body.revisionEventId,
    snapshotHash: body.snapshotHash, checkpointHash: body.checkpointHash,
    signedAt: event.created_at }
}

export function historicalReconciliationSummary(group, checkpoint, rows = []) {
  const members = historicalAttestationParticipants(group)
  const base = { required: members || [], signed: [], pending: members || [],
    safeForPayments: false, completeHistory: false }
  if (!members || !checkpoint || !HEX.test(checkpoint.hash || '') ||
      !HEX.test(checkpoint.snapshotHash || '') || checkpoint.revisionEventId !== group._revisionId ||
      JSON.stringify(checkpoint.participants) !== JSON.stringify(members)) {
    return { ...base, status: 'unavailable' }
  }
  if (!Array.isArray(rows) || rows.length > MAX_HISTORICAL_RECONCILIATIONS) {
    return { ...base, status: 'conflict' }
  }
  const ids = new Map(), signedBy = new Map()
  for (const row of rows) {
    if (!row || !HEX.test(row.id || '') || !members.includes(row.member) ||
        !HEX.test(row.snapshotHash || '') || !HEX.test(row.checkpointHash || '') ||
        row.revisionEventId !== group._revisionId ||
        !Number.isSafeInteger(row.signedAt)) return { ...base, status: 'conflict' }
    const fingerprint = JSON.stringify(row)
    if (ids.has(row.id)) {
      if (ids.get(row.id) !== fingerprint) return { ...base, status: 'conflict' }
      continue // same signed event replayed via multiple relays
    }
    ids.set(row.id, fingerprint)
    if (signedBy.has(row.member) || row.snapshotHash !== checkpoint.snapshotHash ||
        row.checkpointHash !== checkpoint.hash) return { ...base, status: 'conflict' }
    signedBy.set(row.member, row)
  }
  const signed = members.filter(m => signedBy.has(m))
  const pending = members.filter(m => !signedBy.has(m))
  return { ...base, status: pending.length ? 'pending' : 'agreed', signed, pending }
}
