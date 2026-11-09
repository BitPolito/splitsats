import test from 'node:test'
import assert from 'node:assert/strict'
import { KIND_EXPENSE, KIND_EXPENSE_V2, KIND_SETTLEMENT_V2, KIND_CONFIRMATION_V2 } from '../src/lib/constants.js'
import {
  assessFinancialMigrationPreflight, compareFinancialClientObservations,
  assertFinancialV2PublishingDisabled,
} from '../src/lib/financial-migration-preflight.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), H = '1'.repeat(64)
const E = '2'.repeat(64), F = '3'.repeat(64)
const group = () => ({ id: 'trip', pubkey: A, members: [A, B], _revisionId: H,
  _revisionStatus: 'verified', _revisions: [{ id: H, version: 0, members: [A, B] }],
  _consentPolicy: 'signed-invites-v1', _expensePolicy: 'unanimous-expense-v1',
  _inviteStatus: 'accepted', _financialHistoryChecked: true, _priorHistoryChecked: true,
  _financialReviewRequired: false, _expenseReviewRequired: false,
  _financialMigrationQuarantine: false, _historicalActivityDetected: false,
  _priorReplayOverflow: false, _priorEvidenceOverflow: false,
  expenses: [], proposedExpenses: [], settlements: [], confirmations: [],
  _expenseDecisions: [], _cancellationDecisions: [],
})
const address = `30001:${A}:trip`
const clients = (events = [{ id: E, kind: KIND_EXPENSE }]) => [
  { clientId: 'client_a_2026', address, revisionEventId: H, events, eose: true,
    overflow: false, saturated: false, relayConflict: false },
  { clientId: 'client_b_2026', address, revisionEventId: H, events: [...events].reverse(), eose: true,
    overflow: false, saturated: false, relayConflict: false },
]

test('without independent observations a valid fresh group is only pending', () => {
  const result = assessFinancialMigrationPreflight(group(), { outboxEntries: [] })
  assert.equal(result.status, 'pending-peer-review')
  assert.equal(result.v2WriterEnabled, false)
  assert.equal(result.safeForPayments, false)
})
test('matching reports are diagnostic candidate only, never permission', () => {
  const result = assessFinancialMigrationPreflight(group(), { outboxEntries: [], clientReports: clients([]) })
  assert.equal(result.status, 'candidate-only')
  assert.equal(result.clientStatus, 'matching-observed')
  assert.equal(result.v2WriterEnabled, false)
  assert.equal(result.migrationEffective, false)
  assert.ok(result.reasons.includes('requires-future-signed-unanimous-cutover'))
})
test('old financial activity forbids an automatic empty-ledger cutover', () => {
  const g = group(); g.expenses = [{ id: 'old', amount: 50 }]
  const result = assessFinancialMigrationPreflight(g, { outboxEntries: [], clientReports: clients([]) })
  assert.equal(result.status, 'blocked')
  assert.ok(result.reasons.includes('existing-financial-activity-requires-separate-migration'))
})
test('proposed expenses, claims, receipts and decisions also block preflight', () => {
  for (const key of ['proposedExpenses','settlements','confirmations','_expenseDecisions','_cancellationDecisions']) {
    const g = group(); g[key] = [{}]
    assert.equal(assessFinancialMigrationPreflight(g, { outboxEntries: [], clientReports: clients([]) }).status, 'blocked', key)
  }
})
test('readiness never bypasses safety locks or account outbox', () => {
  for (const key of ['_financialMigrationQuarantine','_financialReviewRequired','_expenseReviewRequired',
    '_historicalActivityDetected','_priorReplayOverflow','_priorEvidenceOverflow']) {
    const g = group(); g[key] = true
    assert.equal(assessFinancialMigrationPreflight(g,{outboxEntries:[],clientReports:clients([])}).status,'blocked',key)
  }
  assert.equal(assessFinancialMigrationPreflight(group(), { outboxEntries: [{}], clientReports: clients([]) }).status, 'blocked')
  assert.equal(assessFinancialMigrationPreflight(group(), { clientReports: clients([]) }).status, 'blocked')
})
test('stale head and any revision with old members are excluded', () => {
  const g = group(); g._revisions.push({ id: F, version: 1, members: [A, B] }); g._revisionId = F
  assert.equal(assessFinancialMigrationPreflight(g, { outboxEntries: [], clientReports: clients([]) }).status, 'blocked')
  const h = group(); h._revisions[0].id = F
  assert.equal(assessFinancialMigrationPreflight(h, { outboxEntries: [], clientReports: clients([]) }).status, 'blocked')
})
test('unsigned, unknown-policy, legacy and unsynced groups cannot migrate', () => {
  for (const prop of [['_revisionStatus', 'legacy'],['_inviteStatus','pending'],
    ['_consentPolicy', null],['_expensePolicy',null],['_financialHistoryChecked',false],
    ['_priorHistoryChecked',false]]) {
    const g = group(); g[prop[0]]=prop[1]
    assert.equal(assessFinancialMigrationPreflight(g,{outboxEntries:[],clientReports:clients([])}).status,'blocked',prop[0])
  }
})
test('same clients with different event order still match observed sets', () => {
  const result = compareFinancialClientObservations(group(), clients([{ id: E, kind: KIND_EXPENSE },{ id: F, kind: KIND_EXPENSE_V2 }]))
  assert.equal(result.status,'matching-observed')
  assert.equal(result.observedEventCount,2)
  assert.equal(result.completeHistory,false)
  assert.equal(result.v2WriterEnabled,false)
})
test('divergent sets do not become consistent by union or majority', () => {
  const reports=clients(); reports[1].events = []
  const result=compareFinancialClientObservations(group(),reports)
  assert.equal(result.status,'divergent')
  assert.equal(result.observedEventCount,null)
})
test('missing EOSE, relay discrepancy, overflow, saturation fail closed', () => {
  for (const [key,value] of [['eose',false],['overflow',true],['saturated',true],['relayConflict',true]]) {
    const reports=clients(); reports[0]={...reports[0],[key]:value}
    assert.equal(compareFinancialClientObservations(group(),reports).status,'blocked',key)
  }
})
test('wrong head, other author and duplicate client identifiers are not independent', () => {
  for (const key of ['address','revisionEventId','clientId']) {
    const reports=clients(); reports[1]={...reports[1],[key]:key==='clientId'?reports[0].clientId:'wrong'}
    assert.equal(compareFinancialClientObservations(group(),reports).status,'blocked',key)
  }
})
test('over-cap and duplicated/invalid signed ID summaries fail closed', () => {
  const reports=clients(); reports[0].events=[{ id: E,kind:KIND_EXPENSE },{ id:E,kind:KIND_EXPENSE }]
  assert.equal(compareFinancialClientObservations(group(),reports).status,'blocked')
  reports[0].events=[{ id:'bad',kind:KIND_EXPENSE }]
  assert.equal(compareFinancialClientObservations(group(),reports).status,'blocked')
  reports[0].events=Array.from({length:500},(_,i)=>({id:i.toString(16).padStart(64,'0'),kind:KIND_EXPENSE}))
  assert.equal(compareFinancialClientObservations(group(),reports).status,'blocked')
  assert.equal(compareFinancialClientObservations(group(),Array.from({length:13},(_,i)=>({...clients()[0],clientId:`client_${i}_record` }))).status,'blocked')
})
test('unknown financial kinds cannot be smuggled into an observation', () => {
  const reports=clients(); reports[1].events = [{ id:E,kind:30001 }]
  assert.equal(compareFinancialClientObservations(group(),reports).status,'blocked')
})
test('v2 writer is globally disabled before signer or outbox activity', () => {
  for(const kind of [KIND_EXPENSE_V2,KIND_SETTLEMENT_V2,KIND_CONFIRMATION_V2]) {
    assert.throws(()=>assertFinancialV2PublishingDisabled(kind),err=>err.code==='FINANCIAL_V2_WRITER_DISABLED')
  }
  assert.doesNotThrow(()=>assertFinancialV2PublishingDisabled(KIND_EXPENSE))
})
test('even matching client reports with legacy or v2 financial events block cutover', () => {
  for (const kind of [KIND_EXPENSE,KIND_EXPENSE_V2]) {
    const reports=clients([{ id:E,kind }])
    const state=assessFinancialMigrationPreflight(group(),{outboxEntries:[],clientReports:reports})
    assert.equal(state.status,'blocked')
    assert.ok(state.reasons.includes('financial-events-observed-on-peer'))
    assert.equal(state.v2WriterEnabled,false)
  }
})
test('a divergent client summary never becomes a cutover candidate', () => {
  const reports=clients(); reports[1].events=[]
  const state=assessFinancialMigrationPreflight(group(),{outboxEntries:[],clientReports:reports})
  assert.equal(state.status,'blocked')
  assert.ok(state.reasons.includes('unverified-or-divergent-client-reports'))
})
test('invalid group cannot be made migration-ready by client data', () => {
  const g=group(); g.pubkey='d'.repeat(64)
  assert.equal(assessFinancialMigrationPreflight(g,{outboxEntries:[],clientReports:clients([])}).status,'blocked')
})
