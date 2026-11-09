// Phase 3B-B: read-only, signature-verified mixed-kind observation.
// Nothing observed here may be credited, settled, converted or republished.
// RelayPool MUST verify the Nostr signature before invoking observe().
import { groupAddress } from './group-history.js'
import { parseExpenseEvent, parseSettlementEvent, parseConfirmationEvent } from './event-validation.js'
import {
  KIND_EXPENSE, KIND_SETTLEMENT, KIND_CONFIRMATION,
  KIND_EXPENSE_V2, KIND_SETTLEMENT_V2, KIND_CONFIRMATION_V2,
} from './constants.js'

const HEX = /^[0-9a-f]{64}$/
const MAX_OBSERVED = 500
const FAMILIES = new Map([
  [KIND_EXPENSE, 'expense'], [KIND_EXPENSE_V2, 'expense'],
  [KIND_SETTLEMENT, 'settlement'], [KIND_SETTLEMENT_V2, 'settlement'],
  [KIND_CONFIRMATION, 'confirmation'], [KIND_CONFIRMATION_V2, 'confirmation'],
])
const V2 = new Set([KIND_EXPENSE_V2, KIND_SETTLEMENT_V2, KIND_CONFIRMATION_V2])
const TAGS = new Set(['a', 'g', 'r', 't'])
const hasTag = (event, key, expected) =>
  event.tags.filter(tag => tag[0] === key).length === 1 &&
  event.tags.find(tag => tag[0] === key)[1] === expected

// A live subscription is NOT a closed historical snapshot. New signed events
// after EOSE and temporary relay propagation differences are expected. They
// must not permanently freeze otherwise valid legacy expenses and receipts.
// Preserve sticky quarantine for actual contradictory envelopes or query caps.
// Matching relays never grant payment finality or prove event completeness.
export function liveFinancialRelayRiskReasons(report) {
  if (!report || !Array.isArray(report.relays)) return ['relay-audit-invalid']
  const reasons = []
  if (report.relays.some(row => row?.conflict === true)) reasons.push('relay-conflict')
  if (report.relays.some(row => row?.overflow === true)) reasons.push('relay-overflow')
  if (report.relays.some(row => row?.saturated === true)) reasons.push('relay-at-limit')
  return reasons
}

export const MIXED_FINANCIAL_KINDS = Object.freeze([...FAMILIES.keys()])
export const MAX_MIXED_FINANCIAL_IDS = MAX_OBSERVED

function parsedFinancial(event, group) {
  if (event.kind === KIND_EXPENSE || event.kind === KIND_EXPENSE_V2)
    return parseExpenseEvent(event, group)
  if (event.kind === KIND_SETTLEMENT || event.kind === KIND_SETTLEMENT_V2)
    return parseSettlementEvent(event, group)
  return parseConfirmationEvent(event, group)
}

// A separate verified observer detects contradictory signed statements, but
// NEVER feeds v2 financial data to the active legacy ledger.
export class FinancialKindQuarantine {
  constructor(group) {
    const address = groupAddress(group)
    if (!address || !HEX.test(group?._revisionId || '') ||
        group?._revisionStatus !== 'verified' ||
        !Array.isArray(group.members) || !group.members.length ||
        group.members.some(m => !HEX.test(m))) {
      throw new Error('Guardia finanziaria: gruppo/revisione non verificati')
    }
    this.group = { id: group.id, pubkey: group.pubkey,
      members: [...group.members], _revisionId: group._revisionId }
    this.address = address
    this.seen = new Map()
    this.byLogicalId = new Map()
    this.reasons = new Set()
    this.samples = new Set()
  }

  flag(reason, id = null) {
    this.reasons.add(reason)
    if (HEX.test(id || '') && this.samples.size < 8) this.samples.add(id)
    return this.report()
  }

  observe(event) {
    const family = FAMILIES.get(event?.kind)
    if (!family) return this.report()
    if (!event || !HEX.test(event.id || '') || !HEX.test(event.pubkey || '') ||
        !Number.isSafeInteger(event.created_at) || event.created_at <= 0 ||
        event.created_at > Math.floor(Date.now() / 1000) + 300 ||
        typeof event.content !== 'string' || event.content.length > 16384 ||
        !Array.isArray(event.tags) || event.tags.length > 256 ||
        event.tags.some(tag => !Array.isArray(tag) || tag.length < 2 ||
          typeof tag[0] !== 'string' || typeof tag[1] !== 'string')) {
      return this.flag('invalid-envelope', event?.id)
    }
    if (!this.group.members.includes(event.pubkey) ||
        !hasTag(event, 'a', this.address) ||
        !hasTag(event, 'g', this.group.id) ||
        !hasTag(event, 'r', this.group._revisionId) ||
        !hasTag(event, 't', 'splitsats')) {
      return this.flag('invalid-group-or-revision', event.id)
    }
    // An additional known app tag cannot override the exact signed scope.
    if ([...TAGS].some(key => event.tags.filter(t => t[0] === key).length !== 1)) {
      return this.flag('ambiguous-scope', event.id)
    }
    const identity = JSON.stringify([event.kind, event.pubkey,
      event.created_at, event.tags, event.content, event.sig])
    if (this.seen.has(event.id)) {
      if (this.seen.get(event.id) !== identity) return this.flag('same-id-different-envelope', event.id)
      return this.report() // the same event seen on another relay is idempotent
    }
    if (this.seen.size >= MAX_OBSERVED) return this.flag('audit-cap-reached', event.id)
    this.seen.set(event.id, identity)
    if (this.seen.size === MAX_OBSERVED) this.flag('audit-cap-reached', event.id)

    const isV2 = V2.has(event.kind)
    // v2 cannot be made payable until an independently audited writer and
    // ledger protocol exists. Even a valid v2 event triggers sticky quarantine.
    if (isV2) this.flag('v2-financial-event-observed', event.id)
    const parsed = parsedFinancial(event, this.group)
    if (!parsed) return this.flag(isV2 ? 'unreadable-v2-event' : 'unreadable-legacy-event', event.id)
    const key = JSON.stringify([family, event.pubkey, parsed.id])
    const previous = this.byLogicalId.get(key)
    if (previous && previous.eventId !== event.id) {
      this.flag(previous.kind === event.kind ? 'duplicate-operation-id' : 'mixed-kind-duplicate', event.id)
    } else if (!previous) {
      this.byLogicalId.set(key, { eventId: event.id, kind: event.kind })
    }
    return this.report()
  }

  report() {
    return Object.freeze({
      status: this.reasons.size ? 'quarantine' : 'observing',
      reasons: [...this.reasons].sort(),
      sampleEventIds: [...this.samples].sort().slice(0, 8),
      observedEventCount: this.seen.size,
      // A matching relay snapshot is never finality or evidence of absence.
      safeForPayments: false, completeHistory: false,
    })
  }
}
