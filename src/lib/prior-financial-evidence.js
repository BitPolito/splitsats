// Phase 2E-A: read-only, bounded index of historical Nostr financial events.
// Caller must pass events AFTER Nostr signature verification by RelayPool.
// Evidence is NOT a debt or a balance and cannot unlock any financial action.
import { groupAddress } from './group-history.js'

const HEX = /^[0-9a-f]{64}$/
const KINDS = new Set([9000, 9001, 9002, 9593, 9594])
export const MAX_PRIOR_EVIDENCE = 500

function tagValue(event, key) {
  if (!Array.isArray(event.tags) || !event.tags.every(t =>
    Array.isArray(t) && t.length >= 2 && typeof t[0] === 'string' &&
    typeof t[1] === 'string')) return null
  const values = event.tags.filter(t => t[0] === key)
  return values.length === 1 ? values[0][1] : null
}

export function priorFinancialEvidence(group, event) {
  const chain = group?._revisions
  const address = groupAddress(group)
  if (!address || !Array.isArray(chain) || chain.length < 2 ||
      chain.at(-1)?.id !== group._revisionId ||
      !event || !HEX.test(event.id || '') || !HEX.test(event.pubkey || '') ||
      !KINDS.has(event.kind) || !Number.isSafeInteger(event.created_at) ||
      event.created_at <= 0 || event.created_at > Math.floor(Date.now() / 1000) + 300 ||
      tagValue(event, 'a') !== address || tagValue(event, 'g') !== group.id ||
      tagValue(event, 't') !== 'splitsats') return null
  const revisionId = tagValue(event, 'r')
  const old = chain.slice(0, -1)
  const revisionIndex = old.findIndex(r => r.id === revisionId)
  if (revisionIndex < 0) return null
  const revision = old[revisionIndex]
  if (!Array.isArray(revision.members) || !revision.members.includes(event.pubkey) ||
      !Number.isSafeInteger(revision.createdAt) || event.created_at < revision.createdAt ||
      (revisionIndex + 1 < chain.length && event.created_at >= chain[revisionIndex + 1].createdAt)) return null
  return Object.freeze({ eventId: event.id, revisionId, kind: event.kind,
    author: event.pubkey, signedAt: event.created_at })
}

// Never discard evidence to imply no history. Overflow is a permanent
// conservative state; additional events remain able to keep the group locked.
export function appendPriorEvidence(rows, evidence) {
  if (!Array.isArray(rows) || !evidence || !HEX.test(evidence.eventId || '')) {
    return { rows: Array.isArray(rows) ? rows : [], overflow: true, added: false }
  }
  if (rows.some(row => row.eventId === evidence.eventId)) {
    return { rows, overflow: false, added: false }
  }
  if (rows.length >= MAX_PRIOR_EVIDENCE) return { rows, overflow: true, added: false }
  return { rows: [...rows, evidence], overflow: false, added: true }
}

export function priorEvidenceCounts(rows = []) {
  const result = { expenses: 0, settlements: 0, confirmations: 0,
    decisions: 0, cancellations: 0 }
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.kind === 9000) result.expenses++
    else if (row.kind === 9001) result.settlements++
    else if (row.kind === 9002) result.confirmations++
    else if (row.kind === 9593) result.decisions++
    else if (row.kind === 9594) result.cancellations++
  }
  return result
}
