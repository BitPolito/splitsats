import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools'
import { KIND_FINANCIAL_DESTINATION_CONSENT } from '../src/lib/constants.js'
import { FINANCIAL_MIGRATION_REVIEW_PROPOSAL } from '../src/lib/financial-migration-intents.js'
import { buildFinancialDestinationDraft, financialDestinationConsentContent,
  financialDestinationConsentTags, parseFinancialDestinationConsentEvent } from '../src/lib/financial-destination-consent.js'
import { rememberSignedDestinationEvidence, buildFinancialDestinationEvidenceBundle,
  compareFinancialDestinationEvidenceBundles, inspectFinancialDestinationEvidenceBundle } from '../src/lib/financial-destination-evidence.js'

// Real Schnorr signed fixtures: no fake crypto verifier, no wallet access,
// no network and no Nostr relay publication in these tests.
const KEY_A = new Uint8Array(32).fill(7), KEY_B = new Uint8Array(32).fill(8)
const A = getPublicKey(KEY_A), B = getPublicKey(KEY_B)
const HEAD = '1'.repeat(64), REVIEW_A = '2'.repeat(64), REVIEW_B = '3'.repeat(64)
const TS = Math.floor(Date.now()/1000)-70
const sourceReview=(member,id)=>({id,member,choice:'support-review',
  proposalId:FINANCIAL_MIGRATION_REVIEW_PROPOSAL,revisionEventId:HEAD,createdAt:TS})
const group=()=>({id:'signature-test',pubkey:A,members:[A,B],_revisionId:HEAD,
  _revisionStatus:'verified',_revisions:[{id:HEAD,version:0,createdAt:TS-100,members:[A,B]}],
  _consentPolicy:'signed-invites-v1',_expensePolicy:'unanimous-expense-v1',
  _inviteStatus:'accepted',_financialHistoryChecked:true,_priorHistoryChecked:true,
  _financialReviewRequired:false,_expenseReviewRequired:false,
  _financialMigrationQuarantine:false,_historicalActivityDetected:false,
  _priorReplayOverflow:false,_priorEvidenceOverflow:false,
  expenses:[],proposedExpenses:[],settlements:[],confirmations:[],
  _expenseDecisions:[],_cancellationDecisions:[],
  _migrationReviewRows:[sourceReview(A,REVIEW_A),sourceReview(B,REVIEW_B)],
  _migrationReviewConflict:false,_migrationReviewAudit:{status:'matching-observed'}})
async function ready(){const g=group(),d=await buildFinancialDestinationDraft(g,{outboxEntries:[]});
  assert.equal(d.status,'specific-target-review-only');return {g,d}}
function sign(g,d,sk,choice='support-target-review'){
  return finalizeEvent({kind:KIND_FINANCIAL_DESTINATION_CONSENT,created_at:TS,
    tags:financialDestinationConsentTags(g,d),
    content:JSON.stringify(financialDestinationConsentContent(g,d,choice))},sk)
}
const checked=(g,d,events)=>buildFinancialDestinationEvidenceBundle(
  g,d,events,'matching-observed',verifyEvent)

test('real Nostr Schnorr signatures produce an independently verifiable 9604 export',async()=>{
  const {g,d}=await ready(),e=sign(g,d,KEY_A)
  assert.equal(verifyEvent(e),true)
  const row=parseFinancialDestinationConsentEvent(e,g,d)
  assert.equal(row?.member,A)
  const store=rememberSignedDestinationEvidence([],e,row,verifyEvent)
  assert.equal(store.status,'appended')
  const out=checked(g,d,store.events)
  assert.equal(out.status,'exportable-observation')
  assert.equal(out.bundle.events[0].sig,e.sig)
  assert.equal(out.bundle.events[0].pubkey,A)
  assert.equal(JSON.stringify(out.bundle).includes(JSON.stringify([...KEY_A])),false)
})
test('tampering with a real signed event is rejected on import',async()=>{
  const {g,d}=await ready(),e=sign(g,d,KEY_A)
  const bundle=checked(g,d,[e]).bundle
  const wrong={...bundle,events:[{...e,content:e.content+' '}]}
  assert.equal(inspectFinancialDestinationEvidenceBundle(g,d,wrong,verifyEvent).status,'invalid')
  const wrongSig={...bundle,events:[{...e,sig:'0'.repeat(128)}]}
  assert.equal(inspectFinancialDestinationEvidenceBundle(g,d,wrongSig,verifyEvent).status,'invalid')
})
test('two genuinely signed member reviews match across differently ordered exports',async()=>{
  const {g,d}=await ready(),ea=sign(g,d,KEY_A),eb=sign(g,d,KEY_B)
  const local=checked(g,d,[ea,eb]),peer=checked(g,d,[eb,ea])
  assert.equal(local.verifiedCount,2)
  const result=compareFinancialDestinationEvidenceBundles(g,d,local.bundle,peer.bundle,verifyEvent)
  assert.equal(result.status,'matching-verified-events-only')
  assert.equal(result.activationAllowed,false)
})
test('a different signed preference is a mismatch and not an executable migration',async()=>{
  const {g,d}=await ready(),support=sign(g,d,KEY_A),decline=sign(g,d,KEY_A,'decline-target-review')
  assert.equal(verifyEvent(support),true)
  assert.equal(verifyEvent(decline),true)
  const a=checked(g,d,[support]),b=checked(g,d,[decline])
  assert.equal(compareFinancialDestinationEvidenceBundles(g,d,a.bundle,b.bundle,verifyEvent).status,'divergent')
})
