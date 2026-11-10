import test from 'node:test'
import assert from 'node:assert/strict'
import { KIND_FINANCIAL_DESTINATION_CONSENT } from '../src/lib/constants.js'
import { FINANCIAL_MIGRATION_REVIEW_PROPOSAL } from '../src/lib/financial-migration-intents.js'
import { buildFinancialDestinationDraft, financialDestinationConsentContent,
  financialDestinationConsentTags, parseFinancialDestinationConsentEvent } from '../src/lib/financial-destination-consent.js'
import { rememberSignedDestinationEvidence, buildFinancialDestinationEvidenceBundle,
  inspectFinancialDestinationEvidenceBundle, compareFinancialDestinationEvidenceBundles,
  DESTINATION_EVIDENCE_FORMAT, MAX_DESTINATION_EVIDENCE_EVENTS } from '../src/lib/financial-destination-evidence.js'

// This self-contained suite mocks ONLY the signature-verifier seam. In the
// deployed application it is always wired to nostr-tools.verifyEvent; these
// tests are NOT cryptographic Schnorr test vectors or an authorization test.
const A='a'.repeat(64), B='b'.repeat(64), C='c'.repeat(64), H='1'.repeat(64)
const R1='2'.repeat(64), R2='3'.repeat(64), ID1='4'.repeat(64), ID2='5'.repeat(64)
const GOOD_SIG='9'.repeat(128)
const TS=Math.floor(Date.now()/1000)-100
const sourceReview=(member,id)=>({ member,id,choice:'support-review',
  proposalId:FINANCIAL_MIGRATION_REVIEW_PROPOSAL,
  revisionEventId:H, createdAt:TS })
const group=()=>({id:'trip',pubkey:A,members:[A,B],_revisionId:H,
  _revisionStatus:'verified',_revisions:[{id:H,version:0,createdAt:TS-120,members:[A,B]}],
  _consentPolicy:'signed-invites-v1',_expensePolicy:'unanimous-expense-v1',
  _inviteStatus:'accepted',_financialHistoryChecked:true,_priorHistoryChecked:true,
  _financialReviewRequired:false,_expenseReviewRequired:false,
  _financialMigrationQuarantine:false,_historicalActivityDetected:false,
  _priorReplayOverflow:false,_priorEvidenceOverflow:false,
  expenses:[],proposedExpenses:[],settlements:[],confirmations:[],
  _expenseDecisions:[],_cancellationDecisions:[],
  _migrationReviewRows:[sourceReview(A,R1),sourceReview(B,R2)],
  _migrationReviewConflict:false,_migrationReviewAudit:{status:'matching-observed'},
})
async function fixture(){const g=group(); const draft=await buildFinancialDestinationDraft(g,{outboxEntries:[]});
  assert.equal(draft.status,'specific-target-review-only');return {g,draft}}
const evt=(g,draft,member=A,id=ID1,choice='support-target-review')=>({
  id,pubkey:member,created_at:TS,kind:KIND_FINANCIAL_DESTINATION_CONSENT,
  tags:financialDestinationConsentTags(g,draft),
  content:JSON.stringify(financialDestinationConsentContent(g,draft,choice)),
  sig:GOOD_SIG,
})
const verify=e=>e?.sig===GOOD_SIG
const no=()=>false
const safety=obj=>{for(const k of ['activationAllowed','migrationEffective',
  'v2WriterEnabled','safeForPayments','completeHistory','signedNewGroupCreated',
  'balancesTransferred','legacyNamespaceRetired']) assert.equal(obj[k],false,k)}
const make=(g,draft,events,relay='matching-observed')=>
  buildFinancialDestinationEvidenceBundle(g,draft,events,relay,verify)

test('3B-I export has an explicit public-only, nonfinancial versioned format',async()=>{
  const {g,draft}=await fixture(); const r=make(g,draft,[])
  assert.equal(r.status,'exportable-observation');
  assert.equal(r.bundle.format,DESTINATION_EVIDENCE_FORMAT);
  assert.equal(r.bundle.events.length,0);safety(r)
})
test('valid signed envelope can be remembered and exported only after re-verification',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft),row=parseFinancialDestinationConsentEvent(e,g,draft)
  const r=rememberSignedDestinationEvidence([],e,row,verify)
  assert.equal(r.status,'appended'); assert.equal(r.events.length,1)
  const out=make(g,draft,r.events)
  assert.equal(out.status,'exportable-observation');assert.equal(out.verifiedCount,1)
  assert.equal(out.bundle.events[0].id,e.id);safety(out)
})
test('a forged signature never becomes a signed proof',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft),row=parseFinancialDestinationConsentEvent(e,g,draft)
  assert.equal(rememberSignedDestinationEvidence([],e,row,no).status,'conflict')
  assert.equal(make(g,draft,[e],'matching-observed').status,'exportable-observation')
  assert.equal(buildFinancialDestinationEvidenceBundle(g,draft,[e],'matching-observed',no).status,'invalid')
})
test('a missing verifier fails closed',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft),row=parseFinancialDestinationConsentEvent(e,g,draft)
  assert.equal(rememberSignedDestinationEvidence([],e,row).status,'conflict')
  assert.equal(buildFinancialDestinationEvidenceBundle(g,draft,[e]).status,'invalid')
})
test('same event after reconnect or relay replay is idempotent',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft),row=parseFinancialDestinationConsentEvent(e,g,draft)
  let r=rememberSignedDestinationEvidence([],e,row,verify)
  const repeat=rememberSignedDestinationEvidence(r.events,{...e,tags:e.tags.map(t=>[...t])},row,verify)
  assert.equal(repeat.status,'unchanged');assert.equal(repeat.events.length,1)
})
test('the collector retains only public NIP-01 event fields',async()=>{
  const {g,draft}=await fixture(),e={...evt(g,draft),secretKey:'leak',walletPreimage:'private'}
  const row=parseFinancialDestinationConsentEvent(e,g,draft)
  const r=rememberSignedDestinationEvidence([],e,row,verify)
  assert.equal(r.status,'appended');assert.equal(r.events[0].secretKey,undefined)
  assert.equal(JSON.stringify(r.events).includes('private'),false)
})
test('two verified identical client bundles match only as observations',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft)
  const a=make(g,draft,[e]), b=make(g,draft,[e])
  const result=compareFinancialDestinationEvidenceBundles(g,draft,a.bundle,b.bundle,verify)
  assert.equal(result.status,'matching-verified-events-only');
  assert.equal(result.verifiedCount,1);safety(result)
})
test('arrival order does not change the signed evidence comparison',async()=>{
  const {g,draft}=await fixture(),e1=evt(g,draft,A,ID1),e2=evt(g,draft,B,ID2)
  const a=make(g,draft,[e1,e2]), b=make(g,draft,[e2,e1])
  assert.equal(compareFinancialDestinationEvidenceBundles(g,draft,a.bundle,b.bundle,verify).status,
    'matching-verified-events-only')
})
test('a distinct signed event set in the second client is divergence',async()=>{
  const {g,draft}=await fixture(),e1=evt(g,draft,A,ID1),e2=evt(g,draft,B,ID2)
  const a=make(g,draft,[e1,e2]), b=make(g,draft,[e1])
  const r=compareFinancialDestinationEvidenceBundles(g,draft,a.bundle,b.bundle,verify)
  assert.equal(r.status,'divergent');safety(r)
})
test('missing EOSE in either exported report remains pending',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft)
  const a=make(g,draft,[e]),b=make(g,draft,[e],'pending')
  const r=compareFinancialDestinationEvidenceBundles(g,draft,a.bundle,b.bundle,verify)
  assert.equal(r.status,'pending-relay-observation');safety(r)
})
test('an empty signature set never proves no events exist',async()=>{
  const {g,draft}=await fixture();const a=make(g,draft,[]),b=make(g,draft,[])
  assert.equal(compareFinancialDestinationEvidenceBundles(g,draft,a.bundle,b.bundle,verify).status,'pending')
})
test('foreign source group and author are not accepted',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft)
  const a=make(g,draft,[e]).bundle
  const foreign={...a,sourceGroupAddress:`30001:${C}:trip`}
  assert.equal(inspectFinancialDestinationEvidenceBundle(g,draft,foreign,verify).status,'invalid')
  const wrongEvent={...e,pubkey:C}
  assert.equal(make(g,draft,[wrongEvent]).status,'invalid')
})
test('stale revision and alternate exact-target proposal fail closed',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft),a=make(g,draft,[e]).bundle
  assert.equal(inspectFinancialDestinationEvidenceBundle(g,draft,{...a,sourceRevisionEventId:C},verify).status,'invalid')
  assert.equal(inspectFinancialDestinationEvidenceBundle(g,draft,{...a,proposalHash:C},verify).status,'invalid')
  assert.equal(inspectFinancialDestinationEvidenceBundle(g,draft,{...a,targetGroupAddress:'another'},verify).status,'invalid')
})
test('a tampered or unsigned Nostr envelope is rejected',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft),a=make(g,draft,[e]).bundle
  for(const tamper of [ {...e,sig:'0'.repeat(128)}, {...e,sig:'not-hex'},
    {...e,id:'bad'}, {...e,content:'bad'}, {...e,kind:9000} ]){
    const r=inspectFinancialDestinationEvidenceBundle(g,draft,{...a,events:[tamper]},verify)
    assert.equal(r.status,'invalid')
  }
})
test('same author two distinct signed preferences are a conflict',async()=>{
  const {g,draft}=await fixture();const r=make(g,draft,[evt(g,draft,A,ID1),evt(g,draft,A,ID2)])
  assert.equal(r.status,'conflict');safety(r)
})
test('a duplicated immutable event can appear multiple times without a second vote',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft)
  const out=make(g,draft,[e,e]);assert.equal(out.status,'exportable-observation')
  assert.equal(out.verifiedCount,1)
})
test('the same ID and a changed signed envelope is an invalid collection',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft)
  const other=evt(g,draft,B,ID1)
  assert.equal(make(g,draft,[e,other]).status,'invalid')
})
test('more than the bounded number of events is rejected',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft)
  const tooMany=Array.from({length:MAX_DESTINATION_EVIDENCE_EVENTS+1},()=>e)
  assert.equal(make(g,draft,tooMany).status,'invalid')
})
test('unrecognized relay status and oversize input fail closed',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft),a=make(g,draft,[e]).bundle
  assert.equal(inspectFinancialDestinationEvidenceBundle(g,draft,{...a,reportedRelayStatus:'trusted-final'},verify).status,'invalid')
  assert.equal(inspectFinancialDestinationEvidenceBundle(g,draft,{...a,extra:'x'.repeat(161000)},verify).status,'invalid')
})
test('a signed event whose public content does not match the parsed row is a conflict',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft),row=parseFinancialDestinationConsentEvent(e,g,draft)
  assert.equal(rememberSignedDestinationEvidence([],e,{...row,proposalHash:C},verify).status,'conflict')
})
test('malformed local collector never overwrites valid evidence',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft),row=parseFinancialDestinationConsentEvent(e,g,draft)
  assert.equal(rememberSignedDestinationEvidence('corrupted',e,row,verify).status,'conflict')
  assert.equal(rememberSignedDestinationEvidence([],e,null,verify).status,'conflict')
})
test('signed evidence must be checked again on import, even from this device',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft),a=make(g,draft,[e]).bundle
  const r=compareFinancialDestinationEvidenceBundles(g,draft,a,a,no)
  assert.equal(r.status,'blocked');safety(r)
})
test('modified source head cannot accept previously exported immutable proof',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft),a=make(g,draft,[e]).bundle
  const changed={...g,_revisionId:C}
  assert.equal(inspectFinancialDestinationEvidenceBundle(changed,draft,a,verify).status,'invalid')
})
test('duplicate event id with alternate event content cannot override an existing proof',async()=>{
  const {g,draft}=await fixture(),e=evt(g,draft),row=parseFinancialDestinationConsentEvent(e,g,draft)
  const one=rememberSignedDestinationEvidence([],e,row,verify)
  const tampered={...e,content:'{}'}
  const other=rememberSignedDestinationEvidence(one.events,tampered,row,verify)
  assert.equal(other.status,'conflict');safety(other)
})
