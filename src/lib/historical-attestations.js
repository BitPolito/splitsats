// Phase 2E-C-A: multi-party signed attestation of an OBSERVED historical replay.
// Not a debt release, a completeness certificate or a payment authorization.
// Events passed to the parser must already be Nostr-signature verified by RelayPool.
import { groupAddress } from './group-history.js'
import { KIND_HISTORICAL_ATTESTATION } from './constants.js'

const HEX = /^[0-9a-f]{64}$/
const now = () => Math.floor(Date.now() / 1000)
const SHAPE = ['action', 'groupId', 'revisionEventId', 'snapshotHash', 'version']
export const MAX_HISTORICAL_ATTESTATIONS = 200

export function historicalAttestationParticipants(group) {
  const chain = group?._revisions
  if (!Array.isArray(chain) || chain.length < 2 ||
      chain.at(-1)?.id !== group?._revisionId || !Array.isArray(group?.members) ||
      chain.some(r => !HEX.test(r.id || '') ||
        !Number.isSafeInteger(r.createdAt) || r.createdAt <= 0 ||
        !Array.isArray(r.members) || r.members.length < 2 ||
        r.members.some(m => !HEX.test(m || '')))) return null
  const participants = [...new Set(chain.flatMap(r => r.members))].sort()
  if (participants.length < 2 || participants.length > 100 ||
      !participants.includes(group.pubkey) ||
      group.members.some(m => !participants.includes(m))) return null
  return participants
}

function single(event, key) {
  if (!Array.isArray(event?.tags) || event.tags.length > 128 ||
      !event.tags.every(t => Array.isArray(t) && t.length >= 2 &&
        typeof t[0] === 'string' && typeof t[1] === 'string')) return null
  const tags = event.tags.filter(t => t[0] === key)
  return tags.length === 1 ? tags[0][1] : null
}

function pubkeyTagsMatch(event, participants) {
  const tags = event?.tags?.filter(t => t[0] === 'p') || []
  return tags.length === participants.length && new Set(tags.map(t => t[1])).size === tags.length &&
    tags.every(t => participants.includes(t[1]))
}

export async function buildHistoricalAttestationSnapshot(group, events, replay) {
  const participants = historicalAttestationParticipants(group)
  if (!groupAddress(group) || !participants || group._revisionStatus !== 'verified' ||
      group._priorHistoryChecked !== true || !group._historicalActivityDetected ||
      group._priorReplayOverflow || group._priorEvidenceOverflow ||
      replay?.status !== 'observed' || replay.safeForPayments !== false ||
      !replay.observedNet || typeof replay.observedNet !== 'object' ||
      !Array.isArray(events) || events.length > 600) return null

  const sorted = [], seen = new Map()
  for (const e of events) {
    if (!HEX.test(e?.id || '') || !HEX.test(e?.pubkey || '') ||
        !Number.isSafeInteger(e?.created_at) || !Number.isSafeInteger(e?.kind) ||
        ![9592, 9000, 9001, 9002, 9593, 9594].includes(e.kind)) return null
    const old = seen.get(e.id)
    if (old) {
      if (JSON.stringify(old) !== JSON.stringify(e)) return null
      continue
    }
    seen.set(e.id, e)
    sorted.push([e.id, e.kind, e.pubkey, e.created_at])
  }
  if (!sorted.some(row => row[1] !== 9592)) return null
  sorted.sort((a, b) => a[0].localeCompare(b[0]))
  const totals = replay.observedNet
  if (Object.keys(totals).length !== participants.length ||
      Object.keys(totals).some(k => !participants.includes(k)) ||
      participants.some(pk => !Number.isSafeInteger(totals[pk]))) return null
  let total = 0
  for (const pk of participants) {
    total += totals[pk]
    if (!Number.isSafeInteger(total)) return null
  }
  if (total !== 0) return null

  const canonical = JSON.stringify({
    version: 1, address: groupAddress(group), revisionEventId: group._revisionId,
    participants, signedEvents: sorted,
    observedNet: participants.map(pk => [pk, totals[pk]]),
  })
  if (!globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') return null
  const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  const hash = [...new Uint8Array(hashBytes)].map(b => b.toString(16).padStart(2, '0')).join('')
  return Object.freeze({ hash, revisionEventId: group._revisionId,
    participants, eventCount: sorted.length, safeForPayments: false })
}

export function historicalAttestationTags(group, snapshot) {
  const participants = historicalAttestationParticipants(group)
  if (!groupAddress(group) || !participants || !HEX.test(snapshot?.hash || '') ||
      snapshot.revisionEventId !== group._revisionId ||
      JSON.stringify(snapshot.participants) !== JSON.stringify(participants)) {
    throw new Error('Attestazione storica non valida')
  }
  return [['g', group.id], ['a', groupAddress(group)], ['r', group._revisionId],
    ['x', snapshot.hash], ['t', 'splitsats'], ...participants.map(m => ['p', m])]
}

export function parseHistoricalAttestationEvent(event, group) {
  const participants = historicalAttestationParticipants(group)
  const address = groupAddress(group)
  if (!participants || !address || group._revisionStatus !== 'verified' ||
      event?.kind !== KIND_HISTORICAL_ATTESTATION || !HEX.test(event.id || '') ||
      !HEX.test(event.pubkey || '') || !participants.includes(event.pubkey) ||
      !Number.isSafeInteger(event.created_at) ||
      event.created_at < group._revisions.at(-1).createdAt ||
      event.created_at > now() + 300 || typeof event.content !== 'string' ||
      event.content.length > 512 || event.tags?.length !== participants.length + 5 ||
      single(event, 'g') !== group.id || single(event, 'a') !== address ||
      single(event, 'r') !== group._revisionId || single(event, 't') !== 'splitsats' ||
      !pubkeyTagsMatch(event, participants)) return null
  let data
  try { data = JSON.parse(event.content) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(SHAPE) ||
      data.version !== 1 || data.action !== 'attest-historical-v1' ||
      data.groupId !== group.id || data.revisionEventId !== group._revisionId ||
      !HEX.test(data.snapshotHash || '') || single(event, 'x') !== data.snapshotHash) return null
  return { id: event.id, member: event.pubkey, snapshotHash: data.snapshotHash,
    revisionEventId: data.revisionEventId, signedAt: event.created_at }
}

export function historicalAttestationSummary(group, snapshot, rows = []) {
  const participants = historicalAttestationParticipants(group)
  const base = { required: participants || [], signed: [], pending: participants || [],
    safeForPayments: false }
  if (!participants || !snapshot || snapshot.revisionEventId !== group._revisionId ||
      !HEX.test(snapshot.hash || '') ||
      JSON.stringify(snapshot.participants) !== JSON.stringify(participants)) {
    return { ...base, status: 'unavailable' }
  }
  if (!Array.isArray(rows) || rows.length > MAX_HISTORICAL_ATTESTATIONS) {
    return { ...base, status: 'conflict' }
  }
  const seen = new Map(), ids = new Map()
  for (const item of rows) {
    if (!item || !HEX.test(item.id || '') || !participants.includes(item.member) ||
        !HEX.test(item.snapshotHash || '') || item.revisionEventId !== group._revisionId ||
        !Number.isSafeInteger(item.signedAt)) return { ...base, status: 'conflict' }
    if (ids.has(item.id)) {
      if (JSON.stringify(ids.get(item.id)) !== JSON.stringify(item)) {
        return { ...base, status: 'conflict' }
      }
      continue // identical event replay
    }
    ids.set(item.id, item)
    if (seen.has(item.member) || item.snapshotHash !== snapshot.hash) {
      return { ...base, status: 'conflict' }
    }
    seen.set(item.member, item)
  }
  const signed = participants.filter(m => seen.has(m))
  const pending = participants.filter(m => !seen.has(m))
  return { ...base, status: pending.length ? 'pending' : 'attested', signed, pending }
}
