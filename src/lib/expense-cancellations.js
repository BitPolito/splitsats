// SplitSats Phase 2C: immutable, participant-signed cancellation of a disputed
// expense. The original 9000 proposal, 9593 objections and 9594 cancellations
// remain independently auditable. Signature verification happens in RelayPool.
import { groupAddress } from './group-history.js'
import { KIND_EXPENSE_CANCELLATION } from './constants.js'

const HASH = /^[0-9a-f]{64}$/
const now = () => Math.floor(Date.now() / 1000)

function tags(event, name) {
  if (!Array.isArray(event?.tags) || !event.tags.every(tag =>
    Array.isArray(tag) && tag.length >= 2 && typeof tag[0] === 'string' &&
    typeof tag[1] === 'string')) return null
  return event.tags.filter(tag => tag[0] === name).map(tag => tag[1])
}
function exactly(event, name, value) {
  const matches = tags(event, name)
  return matches !== null && matches.length === 1 && matches[0] === value
}

export function cancellationParticipants(expense) {
  return [...new Set([expense?._pubkey, expense?.paidBy, ...(Array.isArray(expense?.splits) ? expense.splits : [])])].sort()
}

export function expenseCancellationTags(group, expense) {
  const address = groupAddress(group)
  if (!address || !HASH.test(group?._revisionId || '') ||
      !HASH.test(expense?._eventId || '') || !HASH.test(expense?._pubkey || '')) {
    throw new Error('Riferimenti della spesa contestata non validi')
  }
  return [['g', group.id], ['a', address], ['r', group._revisionId],
    ['e', expense._eventId], ['p', expense._pubkey], ['t', 'splitsats']]
}

export function parseExpenseCancellationEvent(event, group) {
  const address = groupAddress(group)
  if (!address || !HASH.test(group?._revisionId || '') ||
      group._expensePolicy !== 'unanimous-expense-v1' ||
      event?.kind !== KIND_EXPENSE_CANCELLATION ||
      !HASH.test(event.id || '') || !HASH.test(event.pubkey || '') ||
      !group.members?.includes(event.pubkey) ||
      !Number.isSafeInteger(event.created_at) || event.created_at <= 0 ||
      event.created_at > now() + 300 ||
      typeof event.content !== 'string' || event.content.length > 1024 ||
      !exactly(event, 'g', group.id) || !exactly(event, 'a', address) ||
      !exactly(event, 'r', group._revisionId) ||
      !exactly(event, 't', 'splitsats')) return null
  let data
  try { data = JSON.parse(event.content) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      data.action !== 'cancel' || data.groupId !== group.id ||
      data.revisionEventId !== group._revisionId ||
      !HASH.test(data.expenseEventId || '') ||
      !HASH.test(data.expenseAuthor || '') ||
      !exactly(event, 'e', data.expenseEventId) ||
      !exactly(event, 'p', data.expenseAuthor)) return null
  return { id: event.id, member: event.pubkey, action: 'cancel',
    expenseEventId: data.expenseEventId, expenseAuthor: data.expenseAuthor,
    revisionEventId: data.revisionEventId, createdAt: event.created_at }
}

// Called after computing the existing signed approval status. A cancellation
// must NEVER erase an approved expense or mask contradictory decisions.
// Any observed cancellation without an existing dispute locks the ledger.
// The entire group must have no recorded settlement/receipt: the existing
// settlement format is not bound to an individual expense.
export function expenseCancellationSummary(group, expense, decisions = [], approvalStatus = 'pending') {
  const absent = { status: 'none', required: [], signed: [], pending: [] }
  if (group?._expensePolicy !== 'unanimous-expense-v1') return absent
  if (!Array.isArray(decisions) || !Array.isArray(expense?.splits) ||
      !HASH.test(expense?._eventId || '') || !HASH.test(expense?._pubkey || '')) {
    return { ...absent, status: 'conflict' }
  }
  const relevant = decisions.filter(d => d?.expenseEventId === expense._eventId)
  if (!relevant.length) return absent
  const required = cancellationParticipants(expense)
  const base = { required, signed: [], pending: required }
  if (group?._revisionStatus !== 'verified' || !HASH.test(group?._revisionId || '') ||
      required.some(pk => !HASH.test(pk || '') || !group.members?.includes(pk)) ||
      approvalStatus === 'conflict') return { ...base, status: 'conflict' }
  const known = new Map()
  const ids = new Set()
  for (const row of relevant) {
    if (!HASH.test(row?.id || '') || ids.has(row.id) ||
        row.action !== 'cancel' || !required.includes(row.member) ||
        row.expenseAuthor !== expense._pubkey ||
        row.revisionEventId !== group._revisionId ||
        !Number.isSafeInteger(row.createdAt) ||
        row.createdAt < (expense._signedAt || 0) || known.has(row.member)) {
      return { ...base, status: 'conflict' }
    }
    ids.add(row.id)
    known.set(row.member, row)
  }
  const signed = required.filter(pk => known.has(pk))
  const pending = required.filter(pk => !known.has(pk))
  if (approvalStatus !== 'disputed' ||
      (group.settlements || []).length || (group.confirmations || []).length) {
    return { status: 'blocked', required, signed, pending }
  }
  return { status: pending.length ? 'pending' : 'cancelled', required, signed, pending }
}
