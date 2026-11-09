import test from 'node:test'
import assert from 'node:assert/strict'
import { KIND_FINANCIAL_DESTINATION_CONSENT, KIND_FINANCIAL_MIGRATION_REVIEW } from '../src/lib/constants.js'
import { FINANCIAL_MIGRATION_REVIEW_PROPOSAL } from '../src/lib/financial-migration-intents.js'
import {
  FINANCIAL_DESTINATION_CONSENT_KIND, FINANCIAL_DESTINATION_CONSENT_DOMAIN,
  buildFinancialDestinationDraft, financialDestinationConsentContent,
  financialDestinationConsentTags, parseFinancialDestinationConsentEvent,
  financialDestinationConsentSummary,
} from '../src/lib/financial-destination-consent.js'

const A='a'.repeat(64), B='b'.repeat(64), C='c'.repeat(64), H='1'.repeat(64)
const ID_A='2'.repeat(64), ID_B='3'.repeat(64), ID_C='4'.repeat(64)
const NOW=Math.floor(Date.now()/1000)-60
const address=`30001:${A}:trip`
const row=(member,id,choice='support-review')=>({member,id,choice,
  proposalId:FINANCIAL_MIGRATION_REVIEW_PROPOSAL,revisionEventId:H,createdAt:NOW})
const group=()=>({id:'trip',pubkey:A,members:[A,B],_revisionId:H,
  _revisionStatus:'verified',_revisions:[{id:H,version:0,createdAt:NOW-100,members:[A,B]}],
  _consentPolicy:'signed-invites-v1',_expensePolicy:'unanimous-expense-v1',
  _inviteStatus:'accepted',_financialHistoryChecked:true,_priorHistoryChecked:true,
  _financialReviewRequired:false,_expenseReviewRequired:false,
  _financialMigrationQuarantine:false,_historicalActivityDetected:false,
  _priorReplayOverflow:false,_priorEvidenceOverflow:false,
  expenses:[],proposedExpenses:[],settlements:[],confirmations:[],
  _expenseDecisions:[],_cancellationDecisions:[],
  _migrationReviewRows:[row(A,ID_A),row(B,ID_B)],
  _migrationReviewConflict:false,_migrationReviewAudit:{status:'matching-observed'}})
const draft=(g=group(),o={})=>buildFinancialDestinationDraft(g,{outboxEntries:[],...o})
const fakeEvent=(g,d,choice='support-target-review',signer=A,id=ID_A)=>({
  id,kind:KIND_FINANCIAL_DESTINATION_CONSENT,pubkey:signer,created_at:NOW,
  tags:financialDestinationConsentTags(g,d),
  content:JSON.stringify(financialDestinationConsentContent(g,d,choice)),
})
const parsed=(g,d,choice='support-target-review',signer=A,id=ID_A)=>
  parseFinancialDestinationConsentEvent(fakeEvent(g,d,choice,signer,id),g,d)
const F = o => {
  for(const x of ['activationAllowed','v2WriterEnabled','migrationEffective','safeForPayments',
    'completeHistory','signedNewGroupCreated','balancesTransferred','legacyNamespaceRetired'])
    assert.equal(o[x],false,x)
}
const changeBody=(e,patch)=>({...e,content:JSON.stringify({...JSON.parse(e.content),...patch})})

test('9604 is a distinct non-financial target review kind',()=>{
  assert.equal(FINANCIAL_DESTINATION_CONSENT_KIND,9604)
  assert.notEqual(FINANCIAL_DESTINATION_CONSENT_KIND,KIND_FINANCIAL_MIGRATION_REVIEW)
  assert.match(FINANCIAL_DESTINATION_CONSENT_DOMAIN,/destination-specific/)
})
test('valid 3B-F plan derives an exact target, not a published group',async()=>{
  const p=await draft();assert.equal(p.status,'specific-target-review-only')
  assert.equal(p.sourceGroupAddress,address);assert.equal(p.sourceRevisionEventId,H)
  assert.match(p.planningFingerprint,/^[0-9a-f]{64}$/)
  assert.match(p.proposalHash,/^[0-9a-f]{64}$/)
  assert.equal(p.targetGroupId,`splitsats-v2-${p.planningFingerprint.slice(0,48)}`)
  assert.equal(p.targetGroupAddress,`30001:${A}:${p.targetGroupId}`)
  assert.notEqual(p.targetGroupAddress,address)
  assert.deepEqual(p.requiredMembers,[A,B]);F(p)
})
test('identical signed state creates deterministic destination and proposal hash',async()=>{
  const x=await draft(),y=await draft()
  assert.equal(x.proposalHash,y.proposalHash)
  assert.equal(x.targetGroupAddress,y.targetGroupAddress)
  F(y)
})
test('relay ordering of 9603 reviews and roster does not affect destination',async()=>{
  const g=group(),x=await draft(g)
  const y=await draft({...g,members:[B,A],_migrationReviewRows:[...g._migrationReviewRows].reverse()})
  assert.equal(x.proposalHash,y.proposalHash)
})
test('changing 9603 event ID changes the exact proposal, never reuses older consent',async()=>{
  const g=group(),x=await draft(g)
  g._migrationReviewRows[1]={...g._migrationReviewRows[1],id:ID_C}
  const y=await draft(g)
  assert.notEqual(x.targetGroupAddress,y.targetGroupAddress)
  assert.notEqual(x.proposalHash,y.proposalHash)
})
test('changing the source revision invalidates historical 9603 signatures',async()=>{
  const g=group();g._revisionId=ID_C
  const p=await draft(g);assert.equal(p.status,'blocked');F(p)
})
test('old financial events block destination proposals',async()=>{
  for(const key of ['expenses','proposedExpenses','settlements','confirmations',
    '_expenseDecisions','_cancellationDecisions']){
    const g=group();g[key]=[{id:'old'}]
    const p=await draft(g);assert.equal(p.status,'blocked',key);F(p)
  }
})
test('incomplete 9603 review cannot name a destination',async()=>{
  const g=group();g._migrationReviewRows=[]
  const p=await draft(g);assert.equal(p.status,'blocked');F(p)
})
test('a declined 9603 preference never becomes consent to new group',async()=>{
  const g=group();g._migrationReviewRows[0].choice='decline-review'
  const p=await draft(g);assert.equal(p.status,'blocked');F(p)
})
test('an outbox with uncertain delivery prevents destination planning',async()=>{
  const p=await draft(group(),{outboxEntries:[{id:ID_C}]})
  assert.equal(p.status,'blocked');F(p)
})
test('unknown outbox is not treated as empty',async()=>{
  const p=await buildFinancialDestinationDraft(group(),{outboxEntries:null})
  assert.equal(p.status,'blocked');F(p)
})
test('quarantined current revision cannot produce a destination',async()=>{
  const g=group();g._financialMigrationQuarantine=true
  const p=await draft(g);assert.equal(p.status,'blocked');F(p)
})
test('malformed group and additional revisions are blocked',async()=>{
  for(const g of [null,{}, {...group(),pubkey:'bad'},
    {...group(),members:[A]}, {...group(),_revisions:[{id:ID_C,version:1}]}]){
    const p=await draft(g);assert.notEqual(p.status,'specific-target-review-only');F(p)
  }
})
test('new consent envelope binds source, target, hash and all members',async()=>{
  const g=group(),p=await draft(g)
  const tags=financialDestinationConsentTags(g,p),data=financialDestinationConsentContent(g,p,'support-target-review')
  assert.deepEqual(tags.slice(0,7),[['g','trip'],['a',address],['r',H],
    ['z',p.targetGroupAddress],['x',p.proposalHash],['v','1'],['t','splitsats']])
  assert.deepEqual(tags.slice(7),[['p',A],['p',B]])
  assert.deepEqual(Object.keys(data).sort(),['action','choice','planningFingerprint','proposalHash',
    'sourceGroupAddress','sourceRevisionEventId','targetGroupAddress','version'])
  assert.equal(data.version,1)
})
test('a source participant may express support, without executing migration',async()=>{
  const g=group(),p=await draft(g),r=parsed(g,p)
  assert.equal(r.member,A);assert.equal(r.proposalHash,p.proposalHash)
  assert.equal(r.targetGroupAddress,p.targetGroupAddress)
  assert.ok(Object.isFrozen(r))
})
test('an invited member can express a signed target preference',async()=>{
  const g=group(),p=await draft(g),r=parsed(g,p,'decline-target-review',B,ID_B)
  assert.equal(r.choice,'decline-target-review');assert.equal(r.member,B)
})
test('a signed 9603 review cannot be misread as destination consent',async()=>{
  const g=group(),p=await draft(g),e=fakeEvent(g,p)
  assert.equal(parseFinancialDestinationConsentEvent({...e,kind:9603},g,p),null)
})
test('unauthorized signer and invalid event identifiers are rejected',async()=>{
  const g=group(),p=await draft(g),e=fakeEvent(g,p)
  for(const changes of [{pubkey:C},{pubkey:'bad'},{id:'bad'},{id:null}])
    assert.equal(parseFinancialDestinationConsentEvent({...e,...changes},g,p),null)
})
test('signed content cannot change target, plan hash, proposal or revision',async()=>{
  const g=group(),p=await draft(g),e=fakeEvent(g,p)
  for(const x of [{targetGroupAddress:address},{planningFingerprint:C},
    {proposalHash:C},{sourceRevisionEventId:C},{sourceGroupAddress:'30001:'+C+':trip'},
    {version:2},{action:'activate-v2'},{choice:'enable-payments'},
    {protocolVersion:1},{schemaVersion:1}])
    assert.equal(parseFinancialDestinationConsentEvent(changeBody(e,x),g,p),null)
})
test('missing, duplicated and forged target or proposal tags are rejected',async()=>{
  const g=group(),p=await draft(g),e=fakeEvent(g,p)
  for(const tags of [e.tags.filter(t=>t[0]!=='z'),
    [...e.tags,['z',p.targetGroupAddress]],
    e.tags.map(t=>t[0]==='z'?['z',address]:t),
    e.tags.filter(t=>t[0]!=='x'),
    [...e.tags,['x',p.proposalHash]],
    e.tags.map(t=>t[0]==='x'?['x',C]:t),
    [...e.tags,['unknown','extra']],
  ]) assert.equal(parseFinancialDestinationConsentEvent({...e,tags},g,p),null)
})
test('missing, duplicated or foreign roster p tags fail closed',async()=>{
  const g=group(),p=await draft(g),e=fakeEvent(g,p)
  for(const tags of [e.tags.filter(t=>t[0]!=='p'),
    [...e.tags,['p',A]],
    e.tags.map(t=>t[0]==='p'&&t[1]===B?['p',C]:t)])
    assert.equal(parseFinancialDestinationConsentEvent({...e,tags},g,p),null)
})
test('malformed JSON, arrays and overlarge content are rejected',async()=>{
  const g=group(),p=await draft(g),e=fakeEvent(g,p)
  for(const content of ['{','[]','null','"bad"','x'.repeat(2049)])
    assert.equal(parseFinancialDestinationConsentEvent({...e,content},g,p),null)
})
test('stale, invalid and future timestamps are rejected',async()=>{
  const g=group(),p=await draft(g),e=fakeEvent(g,p)
  for(const created_at of [0,-1,1.5,'12',NOW-500,Math.floor(Date.now()/1000)+1000])
    assert.equal(parseFinancialDestinationConsentEvent({...e,created_at},g,p),null)
})
test('consent for another current head cannot be replayed',async()=>{
  const g=group(),p=await draft(g),e=fakeEvent(g,p)
  assert.equal(parseFinancialDestinationConsentEvent(e,{...g,_revisionId:C},p),null)
})
test('a foreign or modified draft object cannot borrow the local SHA256 binding',async()=>{
  const g=group(),p=await draft(g),e=fakeEvent(g,p)
  assert.equal(parseFinancialDestinationConsentEvent(e,g,{...p}),null)
  assert.throws(()=>financialDestinationConsentTags(g,{...p}),/Destinazione/)
  assert.throws(()=>financialDestinationConsentContent(g,{...p},'support-target-review'))
})
test('unknown choice cannot be encoded for publication',async()=>{
  const g=group(),p=await draft(g)
  assert.throws(()=>financialDestinationConsentContent(g,p,'migrate-now'))
})
test('a new destination summary starts pending',async()=>{
  const g=group(),p=await draft(g),r=financialDestinationConsentSummary(g,p,[])
  assert.equal(r.status,'pending');assert.deepEqual(r.pendingMembers,[A,B]);F(r)
})
test('one signed preference leaves one signature missing',async()=>{
  const g=group(),p=await draft(g),r=financialDestinationConsentSummary(g,p,[parsed(g,p)])
  assert.equal(r.status,'pending');assert.deepEqual(r.pendingMembers,[B]);F(r)
})
test('two independent support signatures never enable writers',async()=>{
  const g=group(),p=await draft(g),rows=[parsed(g,p),parsed(g,p,'support-target-review',B,ID_B)]
  const r=financialDestinationConsentSummary(g,p,rows,{status:'matching-observed'})
  assert.equal(r.status,'unanimous-target-review-only')
  assert.deepEqual(r.signedMembers,[A,B]);F(r)
})
test('relay audit mismatch refuses even unanimous preference label',async()=>{
  const g=group(),p=await draft(g),rows=[parsed(g,p),parsed(g,p,'support-target-review',B,ID_B)]
  for(const audit of [null,{status:'pending'},{status:'divergent'},{status:'conflict'}]){
    const r=financialDestinationConsentSummary(g,p,rows,audit)
    assert.equal(r.status,'pending-relay-audit');F(r)
  }
})
test('decline defeats unanimity without creating a group',async()=>{
  const g=group(),p=await draft(g),rows=[parsed(g,p),parsed(g,p,'decline-target-review',B,ID_B)]
  const r=financialDestinationConsentSummary(g,p,rows,{status:'matching-observed'})
  assert.equal(r.status,'declined');F(r)
})
test('identical relay delivery deduplicates the same event id',async()=>{
  const g=group(),p=await draft(g),a=parsed(g,p),b=parsed(g,p,'support-target-review',B,ID_B)
  const r=financialDestinationConsentSummary(g,p,[a,a,b,b],{status:'matching-observed'})
  assert.equal(r.status,'unanimous-target-review-only');F(r)
})
test('two distinct signed IDs from the same signer are a conflict',async()=>{
  const g=group(),p=await draft(g),a=parsed(g,p),b={...a,id:ID_C}
  const r=financialDestinationConsentSummary(g,p,[a,b],{status:'matching-observed'})
  assert.equal(r.status,'conflict');F(r)
})
test('same signed ID with divergent content is a conflict',async()=>{
  const g=group(),p=await draft(g),a=parsed(g,p)
  const r=financialDestinationConsentSummary(g,p,[a,{...a,choice:'decline-target-review'}])
  assert.equal(r.status,'conflict');F(r)
})
test('consent to another target, source revision or proposal is not inherited',async()=>{
  const g=group(),p=await draft(g),a=parsed(g,p)
  for(const change of [{proposalHash:C},{targetGroupAddress:'30001:'+A+':other'},
    {sourceRevisionEventId:C},{member:C}]){
    const r=financialDestinationConsentSummary(g,p,[{...a,...change}])
    assert.equal(r.status,'conflict');F(r)
  }
})
test('oversize and invalid rows are conflicts, not a consent quorum',async()=>{
  const g=group(),p=await draft(g)
  for(const rows of [null,Array.from({length:201},()=>null),[null]]){
    const r=financialDestinationConsentSummary(g,p,rows)
    assert.equal(r.status,'conflict');F(r)
  }
})
test('a client-provided draft object cannot be used to claim unanimous consent',async()=>{
  const g=group(),p=await draft(g)
  const r=financialDestinationConsentSummary(g,{...p},[])
  assert.equal(r.status,'unavailable');F(r)
})
