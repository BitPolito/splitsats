import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FINANCIAL_CLIENT_KIND_MATRIX, compareFinancialNamespaceVisibility,
  assessFinancialClientCutoverBarrier,
} from '../src/lib/financial-client-compatibility.js'
import { assertFinancialV2PublishingDisabled } from '../src/lib/financial-migration-preflight.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)
const HEAD = '1'.repeat(64), ID = '2'.repeat(64), ID2 = '3'.repeat(64)
const address = `30001:${A}:trip`
const group = () => ({ id: 'trip', pubkey: A, members: [A,B],
  _revisionId: HEAD, _revisionStatus: 'verified',
  _revisions: [{ id: HEAD, version: 0, members: [A,B] }],
  _consentPolicy: 'signed-invites-v1', _expensePolicy: 'unanimous-expense-v1',
  _inviteStatus: 'accepted', _financialHistoryChecked: true, _priorHistoryChecked: true,
  _financialReviewRequired: false, _expenseReviewRequired: false,
  _financialMigrationQuarantine: false, _historicalActivityDetected: false,
  _priorReplayOverflow: false, _priorEvidenceOverflow: false,
  expenses: [], proposedExpenses: [], settlements: [], confirmations: [],
  _expenseDecisions: [], _cancellationDecisions: [],
  _migrationReviewRows: [], _migrationReviewAudit: null, _migrationReviewConflict: false,
})
const op = (kind = 9000, id = ID, logicalId = 'expense-1', pubkey = A) => ({
  kind, id, logicalId, pubkey, address, revisionEventId: HEAD,
})
const pending = (g = group()) => assessFinancialClientCutoverBarrier(g, { outboxEntries: [] })
const flagsFalse = r => {
  assert.equal(r.activationAllowed, false)
  assert.equal(r.v2WriterEnabled, false)
  assert.equal(r.migrationEffective, false)
  assert.equal(r.safeForPayments, false)
  assert.equal(r.completeHistory, false)
}

test('every legacy client sees only 9000-9002, never the three financial v2 kinds', () => {
  assert.equal(FINANCIAL_CLIENT_KIND_MATRIX.length, 3)
  assert.deepEqual(FINANCIAL_CLIENT_KIND_MATRIX.map(r => r.legacyKind), [9000,9001,9002])
  assert.deepEqual(FINANCIAL_CLIENT_KIND_MATRIX.map(r => r.v2Kind), [9600,9601,9602])
  assert.ok(FINANCIAL_CLIENT_KIND_MATRIX.every(r => r.oldClientReadsV2 === false &&
    r.oldClientReadsLegacy && r.newClientV2Mode === 'quarantine-only'))
})
test('empty untrusted sample is NOT proof of missing finance', () => {
  const r = compareFinancialNamespaceVisibility(group())
  assert.equal(r.status,'empty-untrusted-sample')
  assert.ok(r.reasons.includes('absence-cannot-be-proven'))
  flagsFalse(r)
})
test('legacy-only sample is a diagnostic, not a v2 cutover authorization', () => {
  const r=compareFinancialNamespaceVisibility(group(),[op()])
  assert.equal(r.status,'legacy-only-observed')
  assert.deepEqual(r.legacyVisibleIds,[ID]); flagsFalse(r)
})
test('v2 operation is invisible to old clients even when perfectly formatted', () => {
  const r=compareFinancialNamespaceVisibility(group(),[op(9600)])
  assert.equal(r.status,'legacy-client-blind-to-v2')
  assert.deepEqual(r.v2OnlyIds,[ID]); flagsFalse(r)
})
test('receipt and payment claim v2 are equally invisible to older clients', () => {
  for (const k of [9601,9602]) {
    const r=compareFinancialNamespaceVisibility(group(),[op(k)])
    assert.equal(r.status,'legacy-client-blind-to-v2')
    flagsFalse(r)
  }
})
test('old and new signed ID of the same logical expense cannot double count', () => {
  const r=compareFinancialNamespaceVisibility(group(),[op(9000),op(9600,ID2)])
  assert.equal(r.status,'conflicting-operations')
  assert.deepEqual(r.crossKindDuplicateIds,[ID,ID2])
  flagsFalse(r)
})
test('different signed IDs for same operation in old namespace are also a conflict', () => {
  const r=compareFinancialNamespaceVisibility(group(),[op(),op(9000,ID2)])
  assert.equal(r.status,'conflicting-operations'); flagsFalse(r)
})
test('identical signed ID replayed on another relay is idempotent', () => {
  const r=compareFinancialNamespaceVisibility(group(),[op(),{...op()}])
  assert.equal(r.observedCount,1)
  assert.equal(r.status,'legacy-only-observed')
})
test('same signed ID with divergent scope fails closed', () => {
  const r=compareFinancialNamespaceVisibility(group(),[op(),op(9600)])
  assert.equal(r.status,'invalid-sample')
  flagsFalse(r)
})
test('cross-group and stale revision sample cannot establish compatibility', () => {
  for (const changed of [{address:`30001:${C}:trip`},{revisionEventId:C},{pubkey:C}]) {
    assert.equal(compareFinancialNamespaceVisibility(group(),[{...op(),...changed}]).status,'invalid-sample')
  }
})
test('unknown, invalid and duplicate application identifiers fail closed', () => {
  for(const changed of [{kind:9599},{logicalId:''},{logicalId:'bad\nname'},{id:'oops'}])
    assert.equal(compareFinancialNamespaceVisibility(group(),[{...op(),...changed}]).status,'invalid-sample')
})
test('oversized diagnostic sample does not become a complete history', () => {
  const many=Array.from({length:500},(_,i)=>op(9000,i.toString(16).padStart(64,'0'),`op-${i}`))
  assert.equal(compareFinancialNamespaceVisibility(group(),many).status,'invalid-sample')
})
test('missing or malformed observations never unlock migration', () => {
  for(const rows of [null,{},'hi']) flagsFalse(compareFinancialNamespaceVisibility(group(),rows))
})
test('invalid current head and ambiguous membership refuse interpretation', () => {
  for (const g of [{...group(),_revisionId:'bad'}, {...group(),members:[A,A]}])
    assert.equal(compareFinancialNamespaceVisibility(g).status,'invalid-sample')
})
test('no outbox input or peer attestation cannot become migration permission', () => {
  for(const r of [assessFinancialClientCutoverBarrier(group()),pending()]) {
    assert.ok(['blocked','pending-review'].includes(r.status))
    assert.ok(r.reasons.includes('old-client-retirement-not-verifiable'))
    flagsFalse(r)
  }
})
test('signed review preference alone cannot turn the namespace on', () => {
  const g=group()
  const r=assessFinancialClientCutoverBarrier(g,{outboxEntries:[],observedOperations:[]})
  assert.equal(r.reviewStatus,'pending'); flagsFalse(r)
})
test('explicit legacy/v2 collision blocks the cutover assessment', () => {
  const r=assessFinancialClientCutoverBarrier(group(),{
    outboxEntries:[],observedOperations:[op(9000),op(9600,ID2)]})
  assert.equal(r.status,'blocked'); flagsFalse(r)
})
test('quarantined or disputed existing group stays blocked', () => {
  for(const changed of [{_financialMigrationQuarantine:true},{_financialReviewRequired:true},{_expenseReviewRequired:true}]) {
    const r=pending({...group(),...changed})
    assert.equal(r.status,'blocked'); flagsFalse(r)
  }
})
test('other account and stale client reports cannot establish upgraded peer', () => {
  const r=assessFinancialClientCutoverBarrier(group(),{
    outboxEntries:[],clientReports:[{clientId:'client01',address:'malicious',revisionEventId:HEAD,events:[],eose:true}]})
  assert.equal(r.status,'blocked'); flagsFalse(r)
})
test('a decline or conflicting preference never turns off the legacy-client barrier', () => {
  const r=pending({...group(),_migrationReviewConflict:true})
  assert.equal(r.status,'blocked')
  flagsFalse(r)
})
test('v2 writers stay globally disabled regardless of diagnostic output', () => {
  const r=pending()
  for(const k of [9600,9601,9602]) {
    assert.throws(()=>assertFinancialV2PublishingDisabled(k),e=>e.code==='FINANCIAL_V2_WRITER_DISABLED')
  }
  flagsFalse(r)
})

test('even unanimous matching signed reviews never prove old clients retired', () => {
  const g=group()
  g._migrationReviewRows=[A,B].map((member,i)=>({
    id:(i+4).toString(16).repeat(64), member, choice:'support-review',
    proposalId:'genesis-legacy-9000-9002-to-v2-9600-9602-v1',
    revisionEventId:HEAD, createdAt:1700000000,
  }))
  g._migrationReviewAudit={status:'matching-observed'}
  const r=assessFinancialClientCutoverBarrier(g,{outboxEntries:[]})
  assert.equal(r.reviewStatus,'unanimous-review-observed')
  assert.equal(r.status,'review-only')
  assert.ok(r.reasons.includes('old-client-retirement-not-verifiable'))
  flagsFalse(r)
})

test('client reports asserting all v2 support cannot authorize writers', () => {
  const g=group()
  const clients=[
    {clientId:'client_123',address,revisionEventId:HEAD,events:[],eose:true,overflow:false,saturated:false,relayConflict:false,version:'v2'},
    {clientId:'client_456',address,revisionEventId:HEAD,events:[],eose:true,overflow:false,saturated:false,relayConflict:false,version:'v2'},
  ]
  const r=assessFinancialClientCutoverBarrier(g,{outboxEntries:[],clientReports:clients})
  assert.equal(r.preflightStatus,'candidate-only')
  assert.equal(r.status,'pending-review')
  flagsFalse(r)
})

test('unexpected financial activity on peer report remains blocked even with matching claims', () => {
  const clients=[
    {clientId:'client_123',address,revisionEventId:HEAD,events:[{id:ID,kind:9600}],eose:true,overflow:false,saturated:false,relayConflict:false},
    {clientId:'client_456',address,revisionEventId:HEAD,events:[{id:ID,kind:9600}],eose:true,overflow:false,saturated:false,relayConflict:false},
  ]
  const r=assessFinancialClientCutoverBarrier(group(),{outboxEntries:[],clientReports:clients})
  assert.equal(r.status,'blocked')
  assert.ok(r.reasons.includes('financial-events-observed-on-peer'))
  flagsFalse(r)
})
