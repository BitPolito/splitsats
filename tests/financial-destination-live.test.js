import test from 'node:test'
import assert from 'node:assert/strict'
import { KIND_FINANCIAL_DESTINATION_CONSENT } from '../src/lib/constants.js'
import { FINANCIAL_MIGRATION_REVIEW_PROPOSAL } from '../src/lib/financial-migration-intents.js'
import {
  buildFinancialDestinationDraft, financialDestinationConsentContent,
  financialDestinationConsentTags, parseFinancialDestinationConsentEvent,
  financialDestinationConsentSummary,
} from '../src/lib/financial-destination-consent.js'
import { canSignFinancialDestinationConsent, nonExecutingDestinationReceipt } from '../src/lib/financial-destination-live.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)
const H = '1'.repeat(64), ID_A = '2'.repeat(64), ID_B = '3'.repeat(64)
const TS = Math.floor(Date.now() / 1000) - 90
const sourceReview = (member, id) => ({ member, id, choice: 'support-review',
  proposalId: FINANCIAL_MIGRATION_REVIEW_PROPOSAL, revisionEventId: H, createdAt: TS })
const group = () => ({ id: 'trip', pubkey: A, members: [A, B], _revisionId: H,
  _revisionStatus: 'verified', _revisions: [{ id: H, version: 0, createdAt: TS-100, members: [A,B] }],
  _consentPolicy: 'signed-invites-v1', _expensePolicy: 'unanimous-expense-v1',
  _inviteStatus: 'accepted', _financialHistoryChecked: true, _priorHistoryChecked: true,
  _financialReviewRequired: false, _expenseReviewRequired: false,
  _financialMigrationQuarantine: false, _historicalActivityDetected: false,
  _priorReplayOverflow: false, _priorEvidenceOverflow: false,
  expenses: [], proposedExpenses: [], settlements: [], confirmations: [],
  _expenseDecisions: [], _cancellationDecisions: [],
  _migrationReviewRows: [sourceReview(A, ID_A), sourceReview(B, ID_B)],
  _migrationReviewConflict: false, _migrationReviewAudit: { status: 'matching-observed' },
  _destinationConsentRows: [], _destinationConsentAudit: { status: 'matching-observed' },
  _destinationConsentConflict: false, _destinationConsentDraftHash: null,
})
async function ready() {
  const g = group()
  const draft = await buildFinancialDestinationDraft(g, { outboxEntries: [] })
  assert.equal(draft.status, 'specific-target-review-only')
  g._destinationConsentDraftHash = draft.proposalHash
  return { g, draft }
}
const event = (g, draft, choice, member, id) => ({
  id, kind: KIND_FINANCIAL_DESTINATION_CONSENT, pubkey: member, created_at: TS,
  tags: financialDestinationConsentTags(g, draft),
  content: JSON.stringify(financialDestinationConsentContent(g, draft, choice)),
})
const row = (g, draft, choice, member, id) =>
  parseFinancialDestinationConsentEvent(event(g, draft, choice, member, id), g, draft)
const immutable = x => {
  for (const k of ['activationAllowed', 'migrationEffective', 'v2WriterEnabled',
    'signedNewGroupCreated', 'balancesTransferred', 'legacyNamespaceRetired',
    'safeForPayments', 'completeHistory']) assert.equal(x[k], false, k)
}

test('eligible member may sign a single destination preference when exact source and relays match', async () => {
  const {g,draft} = await ready()
  assert.equal(canSignFinancialDestinationConsent(g,draft,A,[]),true)
  assert.equal(canSignFinancialDestinationConsent(g,draft,B,[]),true)
  assert.equal(canSignFinancialDestinationConsent(g,draft,C,[]),false)
})
test('no outbox, unknown outbox and stale account cannot be inferred from UI state', async () => {
  const {g,draft} = await ready()
  for (const entries of [null,undefined,{},[{id:ID_A}]])
    assert.equal(canSignFinancialDestinationConsent(g,draft,A,entries),false)
  assert.equal(canSignFinancialDestinationConsent(g,draft,'bad',[]),false)
})
test('a missing, stale or conflicting source review blocks every new destination signature', async () => {
  const {g,draft} = await ready()
  for (const updates of [
    {_migrationReviewAudit:{status:'pending'}}, {_migrationReviewAudit:{status:'divergent'}},
    {_migrationReviewConflict:true}, {_financialReviewRequired:true},
    {_financialMigrationQuarantine:true}, {_financialHistoryChecked:false},
    {_revisionId:C}, {members:[A,C]},
  ]) assert.equal(canSignFinancialDestinationConsent({...g,...updates},draft,A,[]),false)
})
test('destination audit is required; bad relay state blocks the signer', async () => {
  const {g,draft} = await ready()
  for (const status of [null,'pending','divergent','conflict','overflow','at-limit']) {
    assert.equal(canSignFinancialDestinationConsent({...g,_destinationConsentAudit: status ? {status} : null},draft,A,[]),false)
  }
})
test('a changed destination fingerprint never borrows old signed 9604 preferences', async () => {
  const {g,draft} = await ready()
  assert.equal(canSignFinancialDestinationConsent({...g,_destinationConsentDraftHash:C},draft,A,[]),false)
  assert.equal(canSignFinancialDestinationConsent({...g,_destinationConsentConflict:true},draft,A,[]),false)
  assert.equal(canSignFinancialDestinationConsent(g,{...draft,proposalHash:C},A,[]),false)
})
test('original relay replay does not duplicate a reviewed signature', async () => {
  const {g,draft} = await ready()
  const first = row(g,draft,'support-target-review',A,ID_A)
  assert.ok(first)
  g._destinationConsentRows = [first, {...first}]
  const result = financialDestinationConsentSummary(g,draft,g._destinationConsentRows,g._destinationConsentAudit)
  assert.equal(result.status,'pending')
  assert.equal(canSignFinancialDestinationConsent(g,draft,A,[]),false)
  assert.equal(canSignFinancialDestinationConsent(g,draft,B,[]),true)
  immutable(result)
})
test('a decline is a signed preference, never an automatic group-creation veto on ledger state', async () => {
  const {g,draft} = await ready()
  g._destinationConsentRows = [row(g,draft,'decline-target-review',A,ID_A)]
  const report = financialDestinationConsentSummary(g,draft,g._destinationConsentRows,g._destinationConsentAudit)
  assert.equal(report.status,'declined')
  assert.equal(canSignFinancialDestinationConsent(g,draft,A,[]),false)
  assert.equal(canSignFinancialDestinationConsent(g,draft,B,[]),false)
  immutable(report)
})
test('all signatures still authorize no destination creation, debts or payment', async () => {
  const {g,draft} = await ready()
  g._destinationConsentRows = [row(g,draft,'support-target-review',A,ID_A),
    row(g,draft,'support-target-review',B,ID_B)]
  const report = financialDestinationConsentSummary(g,draft,g._destinationConsentRows,g._destinationConsentAudit)
  assert.equal(report.status,'unanimous-target-review-only')
  assert.equal(canSignFinancialDestinationConsent(g,draft,A,[]),false)
  assert.equal(canSignFinancialDestinationConsent(g,draft,B,[]),false)
  immutable(report)
})
test('a replay with new signature ID for same member becomes conflict, never renewed consent', async () => {
  const {g,draft} = await ready()
  g._destinationConsentRows = [row(g,draft,'support-target-review',A,ID_A),
    row(g,draft,'support-target-review',A,ID_B)]
  const report = financialDestinationConsentSummary(g,draft,g._destinationConsentRows,g._destinationConsentAudit)
  assert.equal(report.status,'conflict')
  assert.equal(canSignFinancialDestinationConsent(g,draft,B,[]),false)
})
test('a signed 9604 event binds source, target, proposal and complete roster', async () => {
  const {g,draft} = await ready()
  const e = event(g,draft,'support-target-review',A,ID_A)
  assert.equal(parseFinancialDestinationConsentEvent(e,g,draft)?.proposalHash,draft.proposalHash)
  for (const changes of [
    {content: JSON.stringify({...JSON.parse(e.content),proposalHash:C})},
    {tags: e.tags.filter(t=>t[0]!=='x')},
    {tags: [...e.tags,['p',A]]}, {kind:9603}, {pubkey:C},
  ]) assert.equal(parseFinancialDestinationConsentEvent({...e,...changes},g,draft),null)
})
test('publication receipts are diagnostic only and strictly event-id scoped', () => {
  assert.equal(nonExecutingDestinationReceipt('bad'),null)
  const receipt = nonExecutingDestinationReceipt(ID_A)
  assert.equal(receipt.eventId,ID_A)
  immutable(receipt)
  assert.equal(receipt.status,'published-review-only')
  assert.equal(Object.isFrozen(receipt),true)
})
