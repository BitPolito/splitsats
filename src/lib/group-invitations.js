// Signed opt-in for new SplitSats groups. This is not per-expense approval.
// The caller must feed parseInvitationDecisionEvent() signature-verified Nostr events.
import { groupAddress } from './group-history.js'
import { KIND_GROUP_INVITATION } from './constants.js'

export const CONSENT_POLICY = 'signed-invites-v1'
const HASH = /^[0-9a-f]{64}$/
const MAX_FUTURE = 300
const now = () => Math.floor(Date.now() / 1000)

function values(event, key) {
  if (!Array.isArray(event?.tags) || !event.tags.every(t => Array.isArray(t) && t.length >= 2 &&
      typeof t[0] === 'string' && typeof t[1] === 'string')) return null
  return event.tags.filter(t => t[0] === key).map(t => t[1])
}
function single(event, key, expected) {
  const matches = values(event, key)
  return matches !== null && matches.length === 1 && matches[0] === expected
}

export function invitationTags(group) {
  const address = groupAddress(group)
  if (!address || !HASH.test(group?._revisionId || '') || !HASH.test(group?.pubkey || '')) {
    throw new Error('Invito Nostr privo di gruppo o revisione verificata')
  }
  return [['g', group.id], ['a', address], ['r', group._revisionId],
    ['p', group.pubkey], ['t', 'splitsats']]
}

export function parseInvitationDecisionEvent(event, group) {
  if (!groupAddress(group) || !HASH.test(group?._revisionId || '') ||
      group._consentPolicy !== CONSENT_POLICY ||
      event?.kind !== KIND_GROUP_INVITATION || !HASH.test(event?.id || '') ||
      !HASH.test(event?.pubkey || '') || event.pubkey === group.pubkey ||
      !group.members?.includes(event.pubkey) ||
      !Number.isSafeInteger(event.created_at) || event.created_at <= 0 ||
      event.created_at > now() + MAX_FUTURE ||
      (group._revisions?.at(-1)?.createdAt || 0) > event.created_at ||
      typeof event.content !== 'string' || event.content.length > 1024 ||
      !single(event, 'g', group.id) || !single(event, 'a', groupAddress(group)) ||
      !single(event, 'r', group._revisionId) || !single(event, 'p', group.pubkey) ||
      !single(event, 't', 'splitsats')) return null
  let data
  try { data = JSON.parse(event.content) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      data.groupId !== group.id || data.revisionEventId !== group._revisionId ||
      !['accept', 'decline'].includes(data.decision)) return null
  return { id: event.id, member: event.pubkey, decision: data.decision,
    revisionEventId: group._revisionId, createdAt: event.created_at }
}

// A participant may sign ONE immutable decision per revision. Conflicting
// decisions are not silently resolved by relay order or timestamps.
export function invitationSummary(group, decisions = []) {
  if (group?._consentPolicy !== CONSENT_POLICY) return { status: 'legacy', acceptances: [], pending: [] }
  if (group._revisionStatus !== 'verified' || !HASH.test(group._revisionId || '') ||
      !Array.isArray(decisions)) return { status: 'pending', acceptances: [], pending: [] }
  const invited = group.members.filter(pk => pk !== group.pubkey)
  const byMember = new Map()
  for (const decision of decisions) {
    if (!decision || !HASH.test(decision.id || '') ||
        !invited.includes(decision.member) || decision.revisionEventId !== group._revisionId ||
        !['accept', 'decline'].includes(decision.decision) ||
        !Number.isSafeInteger(decision.createdAt) || decision.createdAt <= 0) {
      return { status: 'conflict', acceptances: [], pending: [] }
    }
    const old = byMember.get(decision.member)
    if (old && old.id !== decision.id) return { status: 'conflict', acceptances: [], pending: [] }
    byMember.set(decision.member, decision)
  }
  const acceptances = invited.filter(pk => byMember.get(pk)?.decision === 'accept')
    .sort().map(member => byMember.get(member))
  const pending = invited.filter(pk => !byMember.has(pk))
  const declined = invited.some(pk => byMember.get(pk)?.decision === 'decline')
  return { status: declined ? 'declined' : pending.length ? 'pending' : 'accepted',
    acceptances, pending }
}

export function invitationReceiptTags(group) {
  const result = invitationSummary(group, group._inviteDecisions || [])
  if (result.status !== 'accepted') throw new Error('Inviti non tutti accettati: operazione finanziaria bloccata')
  return result.acceptances.map(x => ['i', x.id])
}

// Required on every post-opt-in expense, settlement and receipt. In addition
// to current acceptance, the signed event commits to *exactly* those receipts.
export function hasInvitationReceipts(group, event) {
  if (group?._consentPolicy !== CONSENT_POLICY) return true
  const result = invitationSummary(group, group._inviteDecisions || [])
  if (result.status !== 'accepted') return false
  const tags = values(event, 'i')
  if (tags === null || tags.length !== result.acceptances.length ||
      new Set(tags).size !== tags.length) return false
  const receipts = result.acceptances.map(x => x.id)
  if (!tags.every(x => receipts.includes(x))) return false
  const latest = Math.max(...result.acceptances.map(x => x.createdAt))
  return Number.isSafeInteger(event.created_at) && event.created_at >= latest
}
