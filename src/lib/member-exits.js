// Phase 2D-B: a member can sign a voluntary exit request. Only the group owner
// may finalize it, and only on a locally observed empty, fully verified ledger.
// A signed request never changes balances or the roster on its own.
// NOTE: Nostr relay EOSE is NOT a proof that financial history is complete.
import { groupAddress } from './group-history.js'
import { KIND_MEMBER_EXIT } from './constants.js'

const KEY = /^[0-9a-f]{64}$/
const time = () => Math.floor(Date.now() / 1000)
const FINANCIAL = ['proposedExpenses', 'expenses', 'settlements', 'confirmations',
  '_expenseDecisions', '_cancellationDecisions']

const values = (event, tag) => {
  if (!Array.isArray(event?.tags) || !event.tags.every(t =>
    Array.isArray(t) && t.length >= 2 && typeof t[0] === 'string' && typeof t[1] === 'string')) return null
  return event.tags.filter(t => t[0] === tag).map(t => t[1])
}
const one = (event, tag, expected) => {
  const found = values(event, tag)
  return found !== null && found.length === 1 && found[0] === expected
}

export function memberExitTags(group) {
  const address = groupAddress(group)
  if (!address || !KEY.test(group?._revisionId || '')) throw new Error('Gruppo non verificato')
  return [['g', group.id], ['a', address], ['r', group._revisionId],
    ['p', group.pubkey], ['t', 'splitsats']]
}

export function parseMemberExitRequestEvent(event, group) {
  const address = groupAddress(group)
  if (!address || event?.kind !== KIND_MEMBER_EXIT || !KEY.test(event?.id || '') ||
      !KEY.test(event?.pubkey || '') || event.pubkey === group.pubkey ||
      !Number.isSafeInteger(event.created_at) || event.created_at <= 0 ||
      event.created_at > time() + 300 || typeof event.content !== 'string' ||
      event.content.length > 1024 || !one(event, 'g', group.id) ||
      !one(event, 'a', address) || !one(event, 't', 'splitsats') ||
      !one(event, 'p', group.pubkey)) return null
  let data
  try { data = JSON.parse(event.content) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      data.action !== 'leave' || data.groupId !== group.id ||
      !KEY.test(data.revisionEventId || '') ||
      !one(event, 'r', data.revisionEventId)) return null
  const prior = (group._revisions || []).find(r => r.id === data.revisionEventId)
  if (!prior || !prior.members?.includes(event.pubkey) ||
      event.created_at < prior.createdAt) return null
  return { id: event.id, member: event.pubkey, action: 'leave',
    revisionEventId: prior.id, createdAt: event.created_at }
}

// A new owner-signed revision can remove one willing member, and must bind to
// that member's exact immutable, independently signed request ID. Older unsigned
// removals remain frozen; they are never silently treated as consented exits.
export function verifyMemberExitProofs(group, requests = []) {
  const chain = group?._revisions
  if (!Array.isArray(chain) || !chain.length || group._revisionStatus !== 'verified') return 'pending'
  if (!Array.isArray(requests)) return 'conflict'
  const expected = []
  for (let i = 1; i < chain.length; i++) {
    const before = chain[i - 1], after = chain[i]
    const removed = before.members.filter(m => !after.members.includes(m))
    const added = after.members.filter(m => !before.members.includes(m))
    if (!removed.length) {
      if (after.exitedMember || after.exitProofEventId) return 'conflict'
      continue
    }
    if (removed.length !== 1 || added.length || removed[0] !== after.exitedMember ||
        !KEY.test(after.exitProofEventId || '') || after.createdAt <= before.createdAt) return 'conflict'
    expected.push({ member: removed[0], previousHead: before.id,
      proofId: after.exitProofEventId, publishedAt: after.createdAt })
  }
  if (!expected.length) return 'verified'
  for (const target of expected) {
    const matching = requests.filter(r => r?.member === target.member &&
      r.revisionEventId === target.previousHead)
    if (matching.length > 1) return 'conflict'
    if (!matching.length) return 'pending'
    const proof = matching[0]
    if (proof.id !== target.proofId || proof.action !== 'leave' ||
        !Number.isSafeInteger(proof.createdAt) || proof.createdAt >= target.publishedAt) return 'conflict'
  }
  return 'verified'
}

function verifyEmptyGroup(group, pendingOutbox, checkTime = time()) {
  if (!groupAddress(group) || group._revisionStatus !== 'verified' ||
      group._financialReviewRequired || group._expenseReviewRequired ||
      group._consentPolicy !== 'signed-invites-v1' ||
      group._expensePolicy !== 'unanimous-expense-v1' ||
      group._inviteStatus !== 'accepted' || !group._financialHistoryChecked ||
      group._historicalActivityDetected) throw new Error('Storico o consensi non verificati')
  if (!Array.isArray(group._revisions) || !group._revisions.length ||
      group._revisions.at(-1).id !== group._revisionId ||
      group._revisions.at(-1).version !== group._revisions.length - 1 ||
      group._revisions.length > 100 ||
      group._revisions.some((r, i) => i > 0 &&
        r.members.some(m => !group._revisions[i - 1].members.includes(m)) &&
        r.members.length < group._revisions[i - 1].members.length)) {
    throw new Error('Catena membership non verificata')
  }
  if (!Array.isArray(group.members) || group.members.length < 3 ||
      group.members.length > 100 || !group.members.includes(group.pubkey) ||
      group.members.some(k => !KEY.test(k)) ||
      new Set(group.members).size !== group.members.length) {
    throw new Error('Servono almeno due membri dopo l’uscita')
  }
  if (!Array.isArray(pendingOutbox) || pendingOutbox.length) {
    throw new Error('Outbox non vuota: ripubblica prima gli eventi gia firmati')
  }
  if (FINANCIAL.some(key => !Array.isArray(group[key]) || group[key].length)) {
    throw new Error('Storico finanziario non vuoto: uscita bloccata')
  }
  if (!Number.isSafeInteger(checkTime) || !Number.isSafeInteger(group._groupCreatedAt) ||
      checkTime <= group._groupCreatedAt) throw new Error('Attendi il secondo successivo alla definizione')
}

export function assertCanRequestExit(group, member, outbox, checkTime = time()) {
  verifyEmptyGroup(group, outbox, checkTime)
  if (!KEY.test(member || '') || member === group.pubkey || !group.members.includes(member)) {
    throw new Error('Solo un membro non proprietario puo richiedere l’uscita')
  }
  if (group._revisions.some(r => !!r.exitedMember)) {
    throw new Error('Uscite precedenti: riconciliazione necessaria')
  }
  if ((group._memberExitRequests || []).some(r => r.member === member &&
      r.revisionEventId === group._revisionId)) throw new Error('Uscita gia richiesta')
  return true
}

export function assertCanFinalizeExit(group, actor, request, outbox, checkTime = time()) {
  verifyEmptyGroup(group, outbox, checkTime)
  if (actor !== group.pubkey) throw new Error('Solo il proprietario puo finalizzare l’uscita')
  if (!request || !KEY.test(request.id || '') || request.action !== 'leave' ||
      request.member === group.pubkey || !group.members.includes(request.member) ||
      request.revisionEventId !== group._revisionId ||
      !Number.isSafeInteger(request.createdAt) || request.createdAt >= checkTime) {
    throw new Error('Richiesta di uscita firmata non valida o troppo recente')
  }
  const matching = (group._memberExitRequests || []).filter(r =>
    r.member === request.member && r.revisionEventId === request.revisionEventId)
  if (matching.length !== 1 || matching[0].id !== request.id) {
    throw new Error('Prova di uscita non univoca')
  }
  // No mixed add/removal or second removal while we lack a versioned historical
  // ledger. Additional exits after an earlier exit remain unsupported.
  if (group._revisions.some(r => !!r.exitedMember)) {
    throw new Error('Uscite precedenti: riconciliazione necessaria')
  }
  return group.members.filter(m => m !== request.member)
}
