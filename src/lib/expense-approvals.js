// Signed approval/objection of expenses in a group with verified, signed invites.
// Only signature-verified relay events may be passed to parseExpenseDecisionEvent.
// The expense event itself is the proposal. An involved proposer implicitly
// approves exactly the proposal that their Nostr key signed.
import { groupAddress } from './group-history.js'
import { KIND_EXPENSE_DECISION } from './constants.js'
import { expenseCancellationSummary } from './expense-cancellations.js'

export const EXPENSE_POLICY = 'unanimous-expense-v1'
const HASH = /^[0-9a-f]{64}$/
const MAX_FUTURE = 300
const now = () => Math.floor(Date.now() / 1000)

function tagValues(event, tag) {
  if (!Array.isArray(event?.tags) || !event.tags.every(t =>
    Array.isArray(t) && t.length >= 2 && typeof t[0] === 'string' && typeof t[1] === 'string')) return null
  return event.tags.filter(t => t[0] === tag).map(t => t[1])
}
function tagIs(event, tag, expected) {
  const values = tagValues(event, tag)
  return values !== null && values.length === 1 && values[0] === expected
}

export function expenseDecisionTags(group, expense) {
  const ref = groupAddress(group)
  if (!ref || !HASH.test(group?._revisionId || '') || !HASH.test(expense?._eventId || '') ||
      !HASH.test(expense?._pubkey || '')) throw new Error('Spesa o revisione Nostr non valida')
  return [['g', group.id], ['a', ref], ['r', group._revisionId],
    ['e', expense._eventId], ['p', expense._pubkey], ['t', 'splitsats']]
}

export function parseExpenseDecisionEvent(event, group) {
  if (!groupAddress(group) || group._expensePolicy !== EXPENSE_POLICY ||
      !HASH.test(group?._revisionId || '') || event?.kind !== KIND_EXPENSE_DECISION ||
      !HASH.test(event.id || '') || !HASH.test(event.pubkey || '') ||
      !group.members?.includes(event.pubkey) || !Number.isSafeInteger(event.created_at) ||
      event.created_at <= 0 || event.created_at > now() + MAX_FUTURE ||
      typeof event.content !== 'string' || event.content.length > 1024 ||
      !tagIs(event, 'g', group.id) || !tagIs(event, 'a', groupAddress(group)) ||
      !tagIs(event, 'r', group._revisionId) || !tagIs(event, 't', 'splitsats')) return null
  let data
  try { data = JSON.parse(event.content) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      !HASH.test(data.expenseEventId || '') || !HASH.test(data.expenseAuthor || '') ||
      data.groupId !== group.id || data.revisionEventId !== group._revisionId ||
      !['approve', 'dispute'].includes(data.decision) ||
      !tagIs(event, 'e', data.expenseEventId) || !tagIs(event, 'p', data.expenseAuthor)) return null
  return { id: event.id, member: event.pubkey, decision: data.decision,
    expenseEventId: data.expenseEventId, expenseAuthor: data.expenseAuthor,
    revisionEventId: group._revisionId, createdAt: event.created_at }
}

export function expenseApprovalSummary(group, expense, decisions = []) {
  if (group?._expensePolicy !== EXPENSE_POLICY) return { status: 'legacy', pending: [], approved: [] }
  if (group?._revisionStatus !== 'verified' || !HASH.test(group?._revisionId || '') ||
      !expense || !HASH.test(expense._eventId || '') || !HASH.test(expense._pubkey || '') ||
      !group.members?.includes(expense._pubkey) || !group.members.includes(expense.paidBy) ||
      !Array.isArray(expense.splits) || !expense.splits.length ||
      !expense.splits.every(pk => group.members.includes(pk)) ||
      !Array.isArray(decisions)) return { status: 'conflict', pending: [], approved: [] }
  const required = [...new Set([expense.paidBy, ...expense.splits])].sort()
  const observed = new Map()
  const ids = new Set()
  for (const decision of decisions) {
    // Events for other expenses are not allowed to affect this proposal.
    if (decision?.expenseEventId !== expense._eventId) continue
    if (!HASH.test(decision.id || '') || ids.has(decision.id) ||
        !required.includes(decision.member) || decision.expenseAuthor !== expense._pubkey ||
        decision.revisionEventId !== group._revisionId ||
        !['approve', 'dispute'].includes(decision.decision) ||
        !Number.isSafeInteger(decision.createdAt) ||
        decision.createdAt < (expense._signedAt || 0)) {
      return { status: 'conflict', pending: [], approved: [] }
    }
    ids.add(decision.id)
    if (observed.has(decision.member)) return { status: 'conflict', pending: [], approved: [] }
    observed.set(decision.member, decision)
  }
  const disputed = required.some(member => observed.get(member)?.decision === 'dispute')
  // A signed expense proposal already commits its author to its exact amount,
  // payer and split; if the author is involved, no second signature is required.
  const approved = required.filter(member => observed.get(member)?.decision === 'approve' ||
    (member === expense._pubkey && !observed.has(member)))
  const pending = required.filter(member => !approved.includes(member) && !observed.has(member))
  return { status: disputed ? 'disputed' : pending.length ? 'pending' : 'approved',
    pending, approved, required }
}

// All proposals remain visible for review; only fully approved ones affect
// balances. A dispute or contradictory signatures triggers a ledger lock.
export function reconcileExpenseApprovals(group) {
  if (group?._expensePolicy !== EXPENSE_POLICY) return group
  const proposals = Array.isArray(group.proposedExpenses) ? group.proposedExpenses : []
  const decisions = Array.isArray(group._expenseDecisions) ? group._expenseDecisions : []
  const approved = []
  let reviewRequired = false
  for (const expense of proposals) {
    const result = expenseApprovalSummary(group, expense, decisions)
    const cancel = expenseCancellationSummary(group, expense,
      group._cancellationDecisions || [], result.status)
    // A unanimous cancellation removes only this proposal from the ledger.
    // It never erases the signed event or its recorded objections.
    if (cancel.status === 'cancelled') continue
    if (result.status === 'approved' && cancel.status === 'none') approved.push(expense)
    if (result.status === 'disputed' || result.status === 'conflict' ||
        (cancel.status !== 'none' && cancel.status !== 'cancelled')) reviewRequired = true
  }
  return { ...group, expenses: reviewRequired ? [] : approved,
    _expenseReviewRequired: reviewRequired }
}
