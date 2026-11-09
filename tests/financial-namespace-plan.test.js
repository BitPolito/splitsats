import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FINANCIAL_NAMESPACE_PLAN_DOMAIN,
  FINANCIAL_NAMESPACE_PLAN_VERSION,
  FINANCIAL_NAMESPACE_STRATEGIES,
  buildFinancialNamespacePlan,
  compareFinancialNamespacePlans,
} from '../src/lib/financial-namespace-plan.js'
import { FINANCIAL_MIGRATION_REVIEW_PROPOSAL } from '../src/lib/financial-migration-intents.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)
const HEAD = '1'.repeat(64), ID_A = '2'.repeat(64), ID_B = '3'.repeat(64)
const NOW = Math.floor(Date.now() / 1000) - 60
const address = `30001:${A}:trip`
const row = (member, id, choice='support-review') => ({
  member, id, choice, proposalId: FINANCIAL_MIGRATION_REVIEW_PROPOSAL,
  revisionEventId: HEAD, createdAt: NOW,
})
const group = () => ({ id:'trip',pubkey:A,members:[A,B],
  _revisionId:HEAD,_revisionStatus:'verified',
  _revisions:[{id:HEAD,version:0,createdAt:NOW-100,members:[A,B]}],
  _consentPolicy:'signed-invites-v1',_expensePolicy:'unanimous-expense-v1',
  _inviteStatus:'accepted',_financialHistoryChecked:true,_priorHistoryChecked:true,
  _financialReviewRequired:false,_expenseReviewRequired:false,
  _financialMigrationQuarantine:false,_historicalActivityDetected:false,
  _priorReplayOverflow:false,_priorEvidenceOverflow:false,
  expenses:[], proposedExpenses:[],settlements:[],confirmations:[],
  _expenseDecisions:[],_cancellationDecisions:[],
  _migrationReviewRows:[row(A,ID_A),row(B,ID_B)],
  _migrationReviewConflict:false,
  _migrationReviewAudit:{status:'matching-observed'},
})
const build=(g=group(),opts={})=>buildFinancialNamespacePlan(g,{outboxEntries:[],...opts})
const flagsFalse = plan => {
  for (const key of ['activationAllowed','migrationEffective','v2WriterEnabled',
    'safeForPayments','completeHistory','signedNewGroupCreated',
    'balancesTransferred','legacyNamespaceRetired'])
    assert.equal(plan[key],false,key)
  assert.equal(plan.proposedNewGroupAddress,null)
  assert.equal(plan.proposedNewGroupId,null)
}

test('namespace strategy always rejects in-place cutover and only simulates independent group',()=>{
  assert.equal(FINANCIAL_NAMESPACE_PLAN_DOMAIN,'splitsats-independent-financial-namespace-preview-v1')
  assert.equal(FINANCIAL_NAMESPACE_PLAN_VERSION,1)
  assert.equal(FINANCIAL_NAMESPACE_STRATEGIES[0].status,'forbidden')
  assert.equal(FINANCIAL_NAMESPACE_STRATEGIES[1].status,'future-proposal-only')
})
test('unanimous review may produce only a local, non-executing proposal fingerprint',async()=>{
  const p=await build()
  assert.equal(p.status,'proposal-only')
  assert.match(p.planningFingerprint,/^[0-9a-f]{64}$/)
  assert.deepEqual(p.evidenceEventIds,[ID_A,ID_B])
  assert.deepEqual(p.reviewedMembers,[A,B])
  assert.equal(p.sourceGroupAddress,address)
  assert.equal(p.sourceRevisionEventId,HEAD)
  flagsFalse(p)
})
test('reversed relay order and reversed member order never change the fingerprint',async()=>{
  const g=group(),x=await build(g)
  const y=await build({...g,members:[B,A],_migrationReviewRows:[...g._migrationReviewRows].reverse()})
  assert.equal(y.status,'proposal-only')
  assert.equal(x.planningFingerprint,y.planningFingerprint)
})
test('changing the signed review ID changes the planning fingerprint',async()=>{
  const g=group(), a=await build(g)
  g._migrationReviewRows[1]={...g._migrationReviewRows[1],id:C}
  const b=await build(g)
  assert.equal(b.status,'proposal-only')
  assert.notEqual(a.planningFingerprint,b.planningFingerprint)
})
test('changing the author-scoped source group changes the preview',async()=>{
  const g=group(),a=await build(g)
  const b=await build({...g,id:'another-group'})
  assert.equal(b.status,'proposal-only')
  assert.notEqual(a.planningFingerprint,b.planningFingerprint)
})
test('changing the signed head cannot borrow the previous reviews',async()=>{
  const g=group(),p=await build({...g,_revisionId:C})
  assert.equal(p.status,'blocked')
  assert.equal(p.planningFingerprint,null)
  flagsFalse(p)
})
test('a missing reviewer is pending, never a plausible namespace',async()=>{
  const g=group();g._migrationReviewRows.pop()
  const p=await build(g)
  assert.equal(p.status,'blocked')
  assert.equal(p.planningFingerprint,null)
  flagsFalse(p)
})
test('declined preference does not propose a namespace',async()=>{
  const g=group();g._migrationReviewRows[1].choice='decline-review'
  const p=await build(g)
  assert.equal(p.status,'blocked');flagsFalse(p)
})
test('different signed statements by same reviewer are conflict',async()=>{
  const g=group();g._migrationReviewRows.push({...g._migrationReviewRows[0],id:C})
  const p=await build(g)
  assert.equal(p.status,'blocked');flagsFalse(p)
})
test('a duplicate event ID cannot be repurposed by a different signer',async()=>{
  const g=group();g._migrationReviewRows[1].id=ID_A
  const p=await build(g)
  assert.equal(p.status,'blocked');flagsFalse(p)
})
test('relay audit mismatch cannot produce a preview fingerprint',async()=>{
  const g=group();g._migrationReviewAudit={status:'divergent'}
  const p=await build(g)
  assert.equal(p.status,'blocked');flagsFalse(p)
})
test('unknown or disconnected relay audit stays blocked',async()=>{
  for(const status of ['pending','overflow','at-limit','conflict']){
    const g=group();g._migrationReviewAudit={status}
    const p=await build(g)
    assert.equal(p.status,'blocked',status);flagsFalse(p)
  }
})
test('financial quarantine stays locked even with unanimous reviews',async()=>{
  const g=group();g._financialMigrationQuarantine=true
  const p=await build(g)
  assert.equal(p.status,'blocked');flagsFalse(p)
})
test('any legacy expense blocks a new namespace preview',async()=>{
  const g=group();g.expenses=[{id:'old',amount:1}]
  const p=await build(g)
  assert.equal(p.status,'blocked');flagsFalse(p)
})
test('unapproved expense, claims and confirmations all block proposal',async()=>{
  for(const key of ['proposedExpenses','settlements','confirmations','_expenseDecisions','_cancellationDecisions']){
    const g=group();g[key]=[{id:'old'}]
    const p=await build(g)
    assert.equal(p.status,'blocked',key);flagsFalse(p)
  }
})
test('an outbox with an uncertain signed event prevents planning',async()=>{
  const p=await build(group(),{outboxEntries:[{id:ID_A}]})
  assert.equal(p.status,'blocked');flagsFalse(p)
})
test('unavailable outbox never pretends to be empty',async()=>{
  const p=await build(group(),{outboxEntries:null})
  assert.equal(p.status,'blocked');flagsFalse(p)
})
test('unsigned remote client reports cannot prove cutover readiness',async()=>{
  const p=await build(group(),{clientReports:[{clientId:'old_client_01',address,revisionEventId:HEAD,events:[],eose:true,overflow:false,saturated:false,relayConflict:false}]})
  assert.equal(p.status,'proposal-only')
  assert.ok(p.reasons.includes('old-clients-can-still-write-legacy-group'))
  flagsFalse(p)
})
test('foreign client report is rejected instead of promoting a preview',async()=>{
  const p=await build(group(),{clientReports:[{clientId:'other_client_01',address:'30001:'+B+':trip',revisionEventId:HEAD,events:[]}]})
  assert.equal(p.status,'blocked');flagsFalse(p)
})
test('observed v2 events prevent a new plan despite matching reviewers',async()=>{
  const p=await build(group(),{observedOperations:[{
    id:C,pubkey:A,logicalId:'expense-1',kind:9600,address,revisionEventId:HEAD,
  }]})
  assert.equal(p.status,'blocked');flagsFalse(p)
})
test('new member chain/history cannot reuse genesis-only review',async()=>{
  const g=group();g._revisions.push({id:C,version:1,members:[A,B]});g._revisionId=C
  const p=await build(g)
  assert.equal(p.status,'blocked');flagsFalse(p)
})
test('empty, legacy and foreign groups do not produce fingerprints',async()=>{
  for (const g of [null,{}, {...group(),pubkey:'bad'}, {...group(),members:[A]}, {...group(),_revisionStatus:'pending'}]){
    const p=await build(g)
    assert.notEqual(p.status,'proposal-only');flagsFalse(p)
  }
})
test('two matching unauthenticated preview fingerprints are diagnostic only',async()=>{
  const p=await build()
  const r=compareFinancialNamespacePlans(group(),[{
    ...p,clientId:'device_alpha_01'}, {...p,clientId:'device_bravo_02'},
  ])
  assert.equal(r.status,'matching-claimed');flagsFalse(r)
})
test('two different fingerprints remain a divergence',async()=>{
  const p=await build()
  const r=compareFinancialNamespacePlans(group(),[
    {...p,clientId:'device_alpha_01'},
    {...p,clientId:'device_bravo_02',planningFingerprint:C},
  ])
  assert.equal(r.status,'divergent');flagsFalse(r)
})
test('duplicate client IDs cannot impersonate independent observations',async()=>{
  const p=await build()
  const r=compareFinancialNamespacePlans(group(),[
    {...p,clientId:'device_alpha_01'}, {...p,clientId:'device_alpha_01'},
  ])
  assert.equal(r.status,'invalid');flagsFalse(r)
})
test('a stale head, foreign group or positive activation flag invalidates preview',async()=>{
  const p=await build()
  for(const patch of [
    {sourceRevisionEventId:C}, {sourceGroupAddress:`30001:${B}:trip`},
    {activationAllowed:true},{v2WriterEnabled:true},{migrationEffective:true},
    {planningFingerprint:'bad'}, {version:2},
  ]){
    const r=compareFinancialNamespacePlans(group(),[
      {...p,clientId:'device_alpha_01'},
      {...p,clientId:'device_bravo_02',...patch},
    ])
    assert.equal(r.status,'invalid',JSON.stringify(patch));flagsFalse(r)
  }
})
test('one report cannot simulate two independent clients',async()=>{
  const p=await build()
  const r=compareFinancialNamespacePlans(group(),[{...p,clientId:'device_alpha_01'}])
  assert.equal(r.status,'pending');flagsFalse(r)
})
test('unbounded client reports fail closed',async()=>{
  const p=await build()
  const rows=Array.from({length:13},(_,i)=>({...p,clientId:`device_${i}_review`}))
  const r=compareFinancialNamespacePlans(group(),rows)
  assert.equal(r.status,'invalid');flagsFalse(r)
})
test('even a matching planning hash cannot settle a single satoshi',async()=>{
  const p=await build()
  const r=compareFinancialNamespacePlans(group(),[
    {...p,clientId:'device_alpha_01'}, {...p,clientId:'device_bravo_02'},
  ])
  assert.equal(p.balancesTransferred,false)
  assert.equal(r.balancesTransferred,false)
  assert.equal(r.safeForPayments,false)
  assert.equal(r.completeHistory,false)
})
