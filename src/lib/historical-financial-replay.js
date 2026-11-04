// Phase 2E-B (diagnostic only): deterministically replay OBSERVED signed
// finance events against the roster and consents of their historical revision.
// Events MUST come from RelayPool after Nostr signature verification. This
// module cannot prove relay completeness and NEVER authorizes a payment.
import { groupAddress } from './group-history.js'
import { membersForRevisionEvent } from './group-revision-log.js'
import { parseExpenseEvent, parseSettlementEvent, parseConfirmationEvent } from './event-validation.js'
import { CONSENT_POLICY, parseInvitationDecisionEvent, invitationSummary, hasInvitationReceipts } from './group-invitations.js'
import { EXPENSE_POLICY, parseExpenseDecisionEvent, expenseApprovalSummary } from './expense-approvals.js'
import { parseExpenseCancellationEvent, expenseCancellationSummary } from './expense-cancellations.js'
import { isConfirmedSettlement } from './settlement-status.js'
import { calcNetBalances } from './balances.js'

export const MAX_HISTORICAL_REPLAY_EVENTS = 600
const KINDS = new Set([9592, 9000, 9001, 9002, 9593, 9594])
const HEX = /^[0-9a-f]{64}$/

const snapshot = (status, reason, revisions = [], observedNet = null) =>
  ({ status, reason, revisions, observedNet, safeForPayments: false })

function singleTag(event, key) {
  if (!Array.isArray(event?.tags) || !event.tags.every(t =>
    Array.isArray(t) && t.length >= 2 && typeof t[0] === 'string' &&
    typeof t[1] === 'string')) return null
  const values = event.tags.filter(t => t[0] === key)
  return values.length === 1 ? values[0][1] : null
}

// Bounded, immutable-ID deduplication for events from signature-verifying
// subscriptions. Keep the original signed envelope for deterministic replay.
export function appendHistoricalReplayEvent(events, event) {
  if (!Array.isArray(events) || !event || !HEX.test(event.id || '') ||
      !HEX.test(event.pubkey || '') || !KINDS.has(event.kind) ||
      typeof event.content !== 'string' || event.content.length > 16384 ||
      !Number.isSafeInteger(event.created_at) || !Array.isArray(event.tags) ||
      event.tags.length > 256 || JSON.stringify(event).length > 32768) {
    return { events: Array.isArray(events) ? events : [], overflow: true, added: false }
  }
  const old = events.find(e => e.id === event.id)
  if (old) return { events, overflow: JSON.stringify(old) !== JSON.stringify(event), added: false }
  if (events.length >= MAX_HISTORICAL_REPLAY_EVENTS) {
    return { events, overflow: true, added: false }
  }
  return { events: [...events, event], overflow: false, added: true }
}

export function replayHistoricalFinancialEvents(group, events, { overflow = false } = {}) {
  const chain = group?._revisions
  if (overflow || group?._priorEvidenceOverflow || !group ||
      group._revisionStatus !== 'verified' || !groupAddress(group) ||
      !Array.isArray(chain) || chain.length < 2 ||
      chain.at(-1)?.id !== group._revisionId ||
      !Array.isArray(events) || events.length > MAX_HISTORICAL_REPLAY_EVENTS) {
    return snapshot('incomplete', 'Registro storico o revisione non verificata')
  }
  if (chain[0].consentPolicy !== CONSENT_POLICY ||
      chain[0].expensePolicy !== EXPENSE_POLICY ||
      chain.some((rev, i) => !HEX.test(rev.id || '') ||
        !Array.isArray(rev.members) || !rev.members.includes(group.pubkey) ||
        !Number.isSafeInteger(rev.createdAt) ||
        (i > 0 && (rev.previousRevisionId !== chain[i - 1].id ||
          rev.createdAt < chain[i - 1].createdAt)))) {
    return snapshot('unsupported', 'Protocollo legacy o catena non supportata')
  }

  const oldHeads = chain.slice(0, -1)
  const byHead = new Map(oldHeads.map(rev => [rev.id, []]))
  const dedupe = new Map()
  const address = groupAddress(group)
  for (const event of events) {
    if (!event || !HEX.test(event.id || '') || !HEX.test(event.pubkey || '') ||
        !KINDS.has(event.kind) || typeof event.content !== 'string' ||
        event.content.length > 16384 || !Array.isArray(event.tags) ||
        event.tags.length > 256 || JSON.stringify(event).length > 32768 ||
        !Number.isSafeInteger(event.created_at) ||
        event.created_at <= 0 || event.created_at > Math.floor(Date.now() / 1000) + 300 ||
        singleTag(event, 'a') !== address || singleTag(event, 'g') !== group.id ||
        singleTag(event, 't') !== 'splitsats') {
      return snapshot('conflict', 'Evento storico non valido o non attribuibile al gruppo')
    }
    const prior = dedupe.get(event.id)
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(event)) {
        return snapshot('conflict', 'ID firmato duplicato con contenuti divergenti')
      }
      continue
    }
    dedupe.set(event.id, event)
    const revisionId = singleTag(event, 'r')
    const rev = oldHeads.find(r => r.id === revisionId)
    if (!rev || !rev.members.includes(event.pubkey) ||
        !membersForRevisionEvent(chain, event)) {
      return snapshot('conflict', 'Evento fuori dalla membership o dal periodo della revisione')
    }
    byHead.get(revisionId).push(event)
  }

  const rows = []
  let needsMore = false
  const union = [...new Set(chain.flatMap(r => r.members))].sort()
  const totals = Object.fromEntries(union.map(member => [member, 0]))
  for (const rev of oldHeads) {
    const perRev = byHead.get(rev.id)
    const scope = { id: group.id, pubkey: group.pubkey, members: rev.members,
      _revisionId: rev.id, _revisionStatus: 'verified',
      _revisions: [rev], _consentPolicy: CONSENT_POLICY, _expensePolicy: EXPENSE_POLICY }
    const invites = []
    for (const event of perRev.filter(e => e.kind === 9592)) {
      const decision = parseInvitationDecisionEvent(event, scope)
      if (!decision) return snapshot('conflict', 'Invito storico malformato', rows)
      invites.push(decision)
    }
    const consent = invitationSummary(scope, invites)
    scope._inviteDecisions = invites
    const financialEvents = perRev.filter(e => e.kind !== 9592)
    if (financialEvents.length && consent.status !== 'accepted') needsMore = true
    if (consent.status === 'declined' || consent.status === 'conflict') {
      return snapshot('conflict', 'Inviti storici rifiutati o contraddittori', rows)
    }

    const proposals = [], decisions = [], cancellations = [], claims = [], confirmations = []
    for (const event of financialEvents) {
      let parsed
      if (event.kind === 9000) {
        parsed = parseExpenseEvent(event, scope)
        if (parsed) proposals.push({ ...parsed, _signedAt: event.created_at })
      } else if (event.kind === 9593) {
        parsed = parseExpenseDecisionEvent(event, scope)
        if (parsed) decisions.push(parsed)
      } else if (event.kind === 9594) {
        parsed = parseExpenseCancellationEvent(event, scope)
        if (parsed) cancellations.push(parsed)
      } else if (event.kind === 9001) {
        parsed = parseSettlementEvent(event, scope)
        if (parsed) claims.push(parsed)
      } else if (event.kind === 9002) {
        parsed = parseConfirmationEvent(event, scope)
        if (parsed) confirmations.push(parsed)
      }
      if (!parsed) return snapshot('conflict', 'Evento finanziario non valido per la revisione', rows)
      if ([9000, 9001, 9002].includes(event.kind) &&
          !hasInvitationReceipts(scope, event)) needsMore = true
    }
    if (new Set(proposals.map(p => `${p._pubkey}:${p.id}`)).size !== proposals.length ||
        new Set(claims.map(c => `${c._pubkey}:${c.id}`)).size !== claims.length) {
      return snapshot('conflict', 'Operazioni ripetute con identificativi diversi', rows)
    }
    const proposalIds = new Set(proposals.map(e => e._eventId))
    const claimIds = new Set(claims.map(s => s._eventId))
    if (decisions.some(d => !proposalIds.has(d.expenseEventId)) ||
        cancellations.some(d => !proposalIds.has(d.expenseEventId)) ||
        confirmations.some(c => !claimIds.has(c.settlementEventId))) needsMore = true

    const approved = []
    const scopeWithClaims = { ...scope, settlements: claims, confirmations }
    for (const expense of proposals) {
      const approval = expenseApprovalSummary(scope, expense, decisions)
      const cancellation = expenseCancellationSummary(scopeWithClaims, expense,
        cancellations, approval.status)
      if (approval.status === 'conflict' || cancellation.status === 'conflict' ||
          cancellation.status === 'blocked') {
        return snapshot('conflict', 'Contestazione o annullamento incompatibile', rows)
      }
      if (cancellation.status === 'cancelled') continue
      if (approval.status === 'approved' && cancellation.status === 'none') approved.push(expense)
      else needsMore = true
    }
    const confirmed = []
    for (const claim of claims) {
      if (isConfirmedSettlement(claim, confirmations)) confirmed.push(claim)
      else needsMore = true
    }
    if (confirmations.some(c => !claims.some(s =>
      s._eventId === c.settlementEventId && s.from === c.from &&
      s.to === c.to && s.amount === c.amount))) needsMore = true
    const net = calcNetBalances(approved, confirmed, rev.members)
    if (Object.values(net).some(v => !Number.isSafeInteger(v)) ||
        Object.values(net).reduce((a,b) => a+b, 0) !== 0) {
      return snapshot('conflict', 'Overflow o sbilanciamento satoshi', rows)
    }
    for (const [key, value] of Object.entries(net)) {
      const next = totals[key] + value
      if (!Number.isSafeInteger(next)) return snapshot('conflict', 'Overflow cumulativo satoshi', rows)
      totals[key] = next
    }
    rows.push({ revisionId: rev.id, members: [...rev.members],
      observedEvents: financialEvents.length, proposedExpenses: proposals.length,
      approvedExpenses: approved.length, confirmedPayments: confirmed.length,
      pendingPayments: claims.length - confirmed.length,
      pendingConsent: financialEvents.length > 0 && consent.status !== 'accepted' })
  }
  if (needsMore) return snapshot('incomplete', 'Consensi, approvazioni o pagamenti non ricostruiti', rows)
  // "observed" is NOT complete, confirmed or final: it is merely a replay of
  // the signed subset received so far from one or more potentially omitting relays.
  return snapshot('observed', 'Simulazione dei soli eventi Nostr osservati', rows, totals)
}
