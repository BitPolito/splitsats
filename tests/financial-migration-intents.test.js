import test from 'node:test'
import assert from 'node:assert/strict'
import { KIND_FINANCIAL_MIGRATION_REVIEW } from '../src/lib/constants.js'
import {
  FINANCIAL_MIGRATION_REVIEW_PROPOSAL, MAX_FINANCIAL_MIGRATION_REVIEWS,
  canReviewFinancialMigration, financialMigrationReviewContent,
  financialMigrationReviewTags, parseFinancialMigrationReviewEvent,
  financialMigrationReviewSummary,
} from '../src/lib/financial-migration-intents.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)
const H = '1'.repeat(64), H2 = '2'.repeat(64)
const ONE = '3'.repeat(64), TWO = '4'.repeat(64), THREE = '5'.repeat(64)
const createdAt = Math.floor(Date.now() / 1000) - 180
const group = () => ({ id: 'trip', pubkey: A, members: [A, B, C], _revisionId: H,
  _revisionStatus: 'verified', _revisions: [{ id: H, version: 0, createdAt: createdAt - 30, members: [A, B, C] }],
  _consentPolicy: 'signed-invites-v1', _expensePolicy: 'unanimous-expense-v1',
  _inviteStatus: 'accepted', _financialHistoryChecked: true, _priorHistoryChecked: true,
  _financialReviewRequired: false, _expenseReviewRequired: false,
  _financialMigrationQuarantine: false, _historicalActivityDetected: false,
  _priorReplayOverflow: false, _priorEvidenceOverflow: false,
  expenses: [], proposedExpenses: [], settlements: [], confirmations: [],
  _expenseDecisions: [], _cancellationDecisions: [],
})
const event = (member, id, choice = 'support-review', g = group()) => ({
  id, kind: KIND_FINANCIAL_MIGRATION_REVIEW, pubkey: member, created_at: createdAt,
  content: JSON.stringify(financialMigrationReviewContent(g, choice)),
  tags: financialMigrationReviewTags(g),
})
const parse = (member, id, choice = 'support-review', g = group()) =>
  parseFinancialMigrationReviewEvent(event(member, id, choice, g), g)
const matching = { status: 'matching-observed' }

// These fixtures represent events already Nostr-signature-verified by RelayPool.
test('kind 9603 and immutable proposal stay distinct from financial writers', () => {
  assert.equal(KIND_FINANCIAL_MIGRATION_REVIEW, 9603)
  assert.equal(FINANCIAL_MIGRATION_REVIEW_PROPOSAL,
    'genesis-legacy-9000-9002-to-v2-9600-9602-v1')
})
test('signed review binds exact genesis revision, app ID and complete roster', () => {
  const row = parse(A, ONE)
  assert.equal(row.member, A)
  assert.equal(row.revisionEventId, H)
  assert.equal(row.proposalId, FINANCIAL_MIGRATION_REVIEW_PROPOSAL)
  assert.equal(event(A, ONE).tags.filter(t => t[0] === 'p').length, 3)
})
test('all members including owner may sign, outsiders cannot', () => {
  assert.ok(parse(A, ONE))
  assert.ok(parse(B, TWO))
  assert.ok(parse(C, THREE))
  assert.equal(parse('d'.repeat(64), ONE), null)
})
test('group, author, revision and proposal tags cannot be substituted', () => {
  const g = group(), e = event(A, ONE)
  for (const key of ['g', 'a', 'r', 'x', 'v', 't']) {
    const bad = { ...e, tags: e.tags.map(t => t[0] === key ? [key, 'wrong'] : t) }
    assert.equal(parseFinancialMigrationReviewEvent(bad, g), null, key)
  }
})
test('duplicate, missing or replaced p tags reject even when signer is valid', () => {
  const e = event(A, ONE), g = group()
  assert.equal(parseFinancialMigrationReviewEvent({ ...e, tags: e.tags.slice(0, -1) }, g), null)
  assert.equal(parseFinancialMigrationReviewEvent({ ...e, tags: [...e.tags.slice(0, -1), ['p', B]] }, g), null)
  assert.equal(parseFinancialMigrationReviewEvent({ ...e, tags: [...e.tags, ['p', B]] }, g), null)
})
test('extra, repeated or non-pair tags cannot silently acquire another meaning', () => {
  const e = event(A, ONE), g = group()
  assert.equal(parseFinancialMigrationReviewEvent({ ...e, tags: [...e.tags, ['z', '1']] }, g), null)
  assert.equal(parseFinancialMigrationReviewEvent({ ...e, tags: [...e.tags.slice(0, -1), ['g', 'trip']] }, g), null)
  assert.equal(parseFinancialMigrationReviewEvent({ ...e, tags: [...e.tags.slice(0, -1), ['p', C, 'x']] }, g), null)
})
test('malformed, future and stale Nostr envelopes fail closed', () => {
  const e = event(A, ONE), g = group()
  assert.equal(parseFinancialMigrationReviewEvent({ ...e, id: 'bad' }, g), null)
  assert.equal(parseFinancialMigrationReviewEvent({ ...e, created_at: createdAt - 100 }, {
    ...g, _revisions: [{ ...g._revisions[0], createdAt: createdAt - 5 }],
  }), null)
  assert.equal(parseFinancialMigrationReviewEvent({ ...e, created_at: createdAt + 5000 }, g), null)
  assert.equal(parseFinancialMigrationReviewEvent({ ...e, content: '{' }, g), null)
})
test('choice or proposal forgery is not interpreted as support', () => {
  const e = event(A, ONE), g = group(), data = JSON.parse(e.content)
  for (const field of ['proposalId', 'action', 'version', 'groupId', 'revisionEventId']) {
    const alt = { ...data, [field]: 'other' }
    assert.equal(parseFinancialMigrationReviewEvent({ ...e, content: JSON.stringify(alt) }, g), null, field)
  }
  assert.equal(parseFinancialMigrationReviewEvent({ ...e, content: JSON.stringify({ ...data, choice: 'enable-payments' }) }, g), null)
  assert.equal(parseFinancialMigrationReviewEvent({ ...e, content: JSON.stringify({ ...data, extra: true }) }, g), null)
})
test('both support and decline are non-executable preferences', () => {
  assert.equal(parse(B, TWO, 'decline-review')?.choice, 'decline-review')
  const r = financialMigrationReviewSummary(group(), [parse(B, TWO, 'decline-review')], matching)
  assert.equal(r.status, 'declined')
  assert.equal(r.migrationEffective, false)
  assert.equal(r.v2WriterEnabled, false)
  assert.equal(r.safeForPayments, false)
})
test('one or two signed preferences leave quorum pending', () => {
  const r = financialMigrationReviewSummary(group(), [parse(A, ONE), parse(B, TWO)], matching)
  assert.equal(r.status, 'pending')
  assert.deepEqual(r.pending, [C])
})
test('all signed support requires independently matching relay observations for review label', () => {
  const rows = [parse(C, THREE), parse(A, ONE), parse(B, TWO)]
  assert.equal(financialMigrationReviewSummary(group(), rows).status, 'pending-relay-audit')
  assert.equal(financialMigrationReviewSummary(group(), rows, { status: 'divergent' }).status, 'pending-relay-audit')
  const r = financialMigrationReviewSummary(group(), rows, matching)
  assert.equal(r.status, 'unanimous-review-observed')
  assert.deepEqual(r.pending, [])
  assert.equal(r.safeForPayments, false)
  assert.equal(r.completeHistory, false)
  assert.equal(r.migrationEffective, false)
})
test('relay replay of the exact same event ID does not create a second preference', () => {
  const rows = [parse(A, ONE), parse(A, ONE), parse(B, TWO), parse(C, THREE)]
  assert.equal(financialMigrationReviewSummary(group(), rows, matching).status, 'unanimous-review-observed')
})
test('two signed preferences from one member are a conflict even with same choice', () => {
  const rows = [parse(A, ONE), parse(A, THREE), parse(B, TWO)]
  assert.equal(financialMigrationReviewSummary(group(), rows, matching).status, 'conflict')
})
test('same immutable signed ID with divergent parsed fields is conflict', () => {
  const rows = [parse(A, ONE), { ...parse(A, ONE), choice: 'decline-review' }]
  assert.equal(financialMigrationReviewSummary(group(), rows, matching).status, 'conflict')
})
test('a single decline rules out a unanimous supporting review', () => {
  const rows = [parse(A, ONE), parse(B, TWO, 'decline-review'), parse(C, THREE)]
  assert.equal(financialMigrationReviewSummary(group(), rows, matching).status, 'declined')
})
test('invalid, overlimit or untrusted evidence cannot produce approval', () => {
  const rows = [parse(A, ONE), { ...parse(B, TWO), proposalId: 'different' }]
  assert.equal(financialMigrationReviewSummary(group(), rows, matching).status, 'conflict')
  assert.equal(financialMigrationReviewSummary(group(), Array(MAX_FINANCIAL_MIGRATION_REVIEWS + 1).fill(parse(A, ONE))).status, 'conflict')
  assert.equal(financialMigrationReviewSummary(group(), [], matching, true).status, 'conflict')
})
test('new revision cannot inherit prior signatures or authorize writes', () => {
  const newer = { ...group(), _revisionId: H2, _revisions: [{ ...group()._revisions[0], id: H2 }] }
  assert.equal(financialMigrationReviewSummary(newer, [parse(A, ONE)], matching).status, 'conflict')
  assert.equal(parseFinancialMigrationReviewEvent(event(A, ONE), newer), null)
})
test('unsupported legacy, historic, incomplete or wrong-policy groups cannot sign', () => {
  for (const change of [
    { _revisionStatus: 'incomplete' }, { _revisions: [] },
    { _consentPolicy: null }, { _financialHistoryChecked: false },
    { _financialMigrationQuarantine: true }, { expenses: [{ amount: 3 }] },
    { _financialReviewRequired: true },
  ]) {
    const g = { ...group(), ...change }
    assert.equal(canReviewFinancialMigration(g, []), false)
  }
})
test('outbox must be available and empty; genesis-only clean group can express a review', () => {
  assert.equal(canReviewFinancialMigration(group(), null), false)
  assert.equal(canReviewFinancialMigration(group(), [{ event: {} }]), false)
  assert.equal(canReviewFinancialMigration(group(), []), true)
})

test('live migration review tolerates valid NEW events after relay EOSE', async () => {
  const { reportLiveFinancialMigrationReviewAudit } = await import('../src/lib/financial-migration-intents.js')
  const a = { phase: 'eose', eose: true, conflict: false, overflow: false,
    saturated: false, late: true, ids: new Map([[ONE, 'valid-signature-envelope']]) }
  const b = { ...a, late: false, ids: new Map() }
  const audit = { relays: new Map([['relay-a', a], ['relay-b', b]]) }
  assert.equal(reportLiveFinancialMigrationReviewAudit(audit).status, 'divergent')
  b.ids.set(ONE, 'valid-signature-envelope')
  const result = reportLiveFinancialMigrationReviewAudit(audit)
  assert.equal(result.status, 'matching-observed')
  assert.equal(result.safeForPayments, false)
})
test('live migration review still refuses different immutable envelopes', async () => {
  const { reportLiveFinancialMigrationReviewAudit } = await import('../src/lib/financial-migration-intents.js')
  const a = { phase: 'eose', eose: true, ids: new Map([[ONE, 'signed-envelope-A']]) }
  const b = { phase: 'eose', eose: true, ids: new Map([[ONE, 'signed-envelope-B']]) }
  const audit = { relays: new Map([['a', a], ['b', b]]) }
  assert.equal(reportLiveFinancialMigrationReviewAudit(audit).status, 'divergent')
  b.conflict = true
  assert.equal(reportLiveFinancialMigrationReviewAudit(audit).status, 'conflict')
})
test('relay disconnect, missing EOSE, overflow and query saturation remain unsafe', async () => {
  const { reportLiveFinancialMigrationReviewAudit } = await import('../src/lib/financial-migration-intents.js')
  const a = { phase: 'eose', eose: true, ids: new Map() }
  const b = { phase: 'offline', eose: false, ids: new Map() }
  const audit = { relays: new Map([['a', a], ['b', b]]) }
  assert.equal(reportLiveFinancialMigrationReviewAudit(audit).status, 'pending')
  b.phase = 'eose'; b.eose = true; b.saturated = true
  assert.equal(reportLiveFinancialMigrationReviewAudit(audit).status, 'at-limit')
  b.saturated = false; b.overflow = true
  assert.equal(reportLiveFinancialMigrationReviewAudit(audit).status, 'overflow')
})
