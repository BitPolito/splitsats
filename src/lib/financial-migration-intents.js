// SplitSats Phase 3B-D: signed *review preferences* for a prospective financial
// namespace migration. These are public Nostr events, not migration approvals,
// payment receipts, debt waivers or proof that clients/relays are synchronized.
// Input events MUST have a valid Nostr signature verified by RelayPool first.
import { groupAddress } from './group-history.js'
import { KIND_FINANCIAL_MIGRATION_REVIEW } from './constants.js'
import { assessFinancialMigrationPreflight } from './financial-migration-preflight.js'

const HEX = /^[0-9a-f]{64}$/
const ACTION = 'review-financial-kind-migration-v1'
const PROPOSAL = 'genesis-legacy-9000-9002-to-v2-9600-9602-v1'
const CHOICES = new Set(['support-review', 'decline-review'])
const KEYS = ['action', 'choice', 'groupId', 'proposalId', 'revisionEventId', 'version']
const MAX_ROWS = 200
const now = () => Math.floor(Date.now() / 1000)

export const FINANCIAL_MIGRATION_REVIEW_PROPOSAL = PROPOSAL
export const MAX_FINANCIAL_MIGRATION_REVIEWS = MAX_ROWS

// Unlike closed historical financial snapshots, this is a LIVE subscription:
// new preferences after EOSE are expected, not evidence of historic tampering.
// The report is diagnostic; even matching relay views grant no authorization.
export function reportLiveFinancialMigrationReviewAudit(audit) {
  const rows = audit?.relays instanceof Map ? [...audit.relays.values()] : []
  let status = 'pending'
  if (!rows.length) status = 'invalid'
  else if (rows.some(r => r.conflict)) status = 'conflict'
  else if (rows.some(r => r.overflow)) status = 'overflow'
  else if (rows.some(r => r.saturated)) status = 'at-limit'
  else if (rows.every(r => r.eose && r.phase === 'eose')) {
    const base = rows[0].ids
    const equal = rows.every(r => r.ids.size === base.size &&
      [...base].every(([id, identity]) => r.ids.get(id) === identity))
    status = rows.length >= 2 && equal ? 'matching-observed' : 'divergent'
  }
  return Object.freeze({ status, relayCount: rows.length,
    completedRelays: rows.filter(r => r.eose && r.phase === 'eose').length,
    safeForPayments: false, completeHistory: false })
}

const base = (status, required, signed = [], reasons = []) => Object.freeze({
  status, required, signed, pending: required.filter(pk => !signed.includes(pk)),
  reasons: [...new Set(reasons)].sort(),
  // Intentionally invariant: no review observation can authorize a migration.
  migrationEffective: false, v2WriterEnabled: false,
  safeForPayments: false, completeHistory: false,
})

function participants(group) {
  if (!groupAddress(group) || !HEX.test(group?._revisionId || '') ||
      group?._revisionStatus !== 'verified' ||
      !Array.isArray(group._revisions) || group._revisions.length !== 1 ||
      group._revisions[0]?.id !== group._revisionId ||
      group._revisions[0]?.version !== 0 ||
      group._consentPolicy !== 'signed-invites-v1' ||
      group._expensePolicy !== 'unanimous-expense-v1' ||
      !Array.isArray(group.members) || group.members.length < 2 ||
      group.members.length > 100 || !group.members.includes(group.pubkey) ||
      group.members.some(pk => !HEX.test(pk)) ||
      new Set(group.members).size !== group.members.length) return null
  return [...group.members].sort()
}

// A signed preference may be considered only for locally clean groups; even
// that is NOT evidence of relay completeness or all clients being upgraded.
export function canReviewFinancialMigration(group, outboxEntries) {
  if (!participants(group) || !Array.isArray(outboxEntries)) return false
  const review = assessFinancialMigrationPreflight(group, { outboxEntries })
  const allowed = new Set([
    'requires-future-signed-unanimous-cutover',
    'older-client-compatibility-unresolved',
    'need-independent-client-observations',
    'unsigned-observation-only',
  ])
  return review.status !== 'blocked' && review.reasons.every(reason => allowed.has(reason))
}

export function financialMigrationReviewContent(group, choice) {
  if (!participants(group) || !CHOICES.has(choice)) throw new Error('Proposta di migrazione non valida')
  return { version: 1, action: ACTION, choice, proposalId: PROPOSAL,
    groupId: group.id, revisionEventId: group._revisionId }
}

export function financialMigrationReviewTags(group) {
  const members = participants(group)
  if (!members) throw new Error('Gruppo non verificato per la revisione di migrazione')
  return [['g', group.id], ['a', groupAddress(group)], ['r', group._revisionId],
    ['x', PROPOSAL], ['v', '1'], ['t', 'splitsats'],
    ...members.map(pk => ['p', pk])]
}

function exactTag(tags, key, value) {
  const items = tags.filter(t => t[0] === key)
  return items.length === 1 && items[0][1] === value
}

export function parseFinancialMigrationReviewEvent(event, group) {
  const members = participants(group)
  if (!members || event?.kind !== KIND_FINANCIAL_MIGRATION_REVIEW ||
      !HEX.test(event?.id || '') || !members.includes(event?.pubkey) ||
      !Number.isSafeInteger(event?.created_at) || event.created_at <= 0 ||
      event.created_at > now() + 300 ||
      event.created_at < (group._revisions[0]?.createdAt || 0) ||
      typeof event.content !== 'string' || event.content.length > 1024 ||
      !Array.isArray(event.tags) || event.tags.length !== members.length + 6 ||
      event.tags.some(t => !Array.isArray(t) || t.length !== 2 ||
        typeof t[0] !== 'string' || typeof t[1] !== 'string' || t[1].length > 256) ||
      !exactTag(event.tags, 'g', group.id) ||
      !exactTag(event.tags, 'a', groupAddress(group)) ||
      !exactTag(event.tags, 'r', group._revisionId) ||
      !exactTag(event.tags, 'x', PROPOSAL) ||
      !exactTag(event.tags, 'v', '1') ||
      !exactTag(event.tags, 't', 'splitsats')) return null
  const p = event.tags.filter(t => t[0] === 'p').map(t => t[1]).sort()
  if (JSON.stringify(p) !== JSON.stringify(members)) return null
  let data
  try { data = JSON.parse(event.content) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(KEYS) ||
      data.version !== 1 || data.action !== ACTION ||
      !CHOICES.has(data.choice) || data.proposalId !== PROPOSAL ||
      data.groupId !== group.id || data.revisionEventId !== group._revisionId) return null
  return { id: event.id, member: event.pubkey, choice: data.choice,
    proposalId: PROPOSAL, revisionEventId: group._revisionId,
    createdAt: event.created_at }
}

// Audit status is advisory; matching relay EOSE cannot prove global finality.
// Unanimity is only a record of signed preferences, never permission to write v2.
export function financialMigrationReviewSummary(group, rows = [], relayAudit = null, invalid = false) {
  const members = participants(group)
  if (!members) return base('unavailable', [], [], ['invalid-group-or-revision'])
  if (invalid || !Array.isArray(rows) || rows.length > MAX_ROWS)
    return base('conflict', members, [], ['invalid-or-over-limit-evidence'])
  const byId = new Map(), byMember = new Map()
  for (const row of rows) {
    if (!row || !HEX.test(row.id || '') || !members.includes(row.member) ||
        !CHOICES.has(row.choice) || row.proposalId !== PROPOSAL ||
        row.revisionEventId !== group._revisionId ||
        !Number.isSafeInteger(row.createdAt) || row.createdAt <= 0 ||
        row.createdAt < (group._revisions[0]?.createdAt || 0))
      return base('conflict', members, [...byMember.keys()], ['invalid-signed-preference'])
    const fingerprint = JSON.stringify([row.member, row.choice, row.proposalId,
      row.revisionEventId, row.createdAt])
    const prior = byId.get(row.id)
    if (prior) {
      if (prior !== fingerprint) return base('conflict', members, [...byMember.keys()], ['same-id-different-content'])
      continue // identical signed event replay through multiple relays
    }
    byId.set(row.id, fingerprint)
    if (byMember.has(row.member))
      return base('conflict', members, [...byMember.keys()], ['duplicate-member-preference'])
    byMember.set(row.member, row)
  }
  const signed = members.filter(pk => byMember.has(pk))
  if ([...byMember.values()].some(row => row.choice === 'decline-review'))
    return base('declined', members, signed, ['at-least-one-member-declined'])
  if (signed.length !== members.length) return base('pending', members, signed)
  if (relayAudit?.status !== 'matching-observed')
    return base('pending-relay-audit', members, signed, ['relay-snapshot-not-matching'])
  return base('unanimous-review-observed', members, signed,
    ['review-only-no-client-upgrade-proof'])
}
