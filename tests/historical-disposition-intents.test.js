import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHistoricalDispositionDrafts } from '../src/lib/historical-disposition.js'
import { KIND_HISTORICAL_DISPOSITION_INTENT } from '../src/lib/constants.js'
import { historicalDispositionIntentTags, parseHistoricalDispositionIntentEvent,
  historicalDispositionIntentSummary, historicalDispositionIntentReady,
} from '../src/lib/historical-disposition-intents.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)
const H0 = '0'.repeat(64), H1 = '1'.repeat(64), S = 'e'.repeat(64)
const ts = Math.floor(Date.now()/1000) - 150
const group = () => ({ id: 'trip', pubkey: A, members:[A,C], _revisionId:H1,
  _revisionStatus:'verified', _financialReviewRequired:true, _priorHistoryChecked:true,
  _historicalActivityDetected:true, _reconciliationDecisionsChecked:true,
  _priorReplayOverflow:false, _priorEvidenceOverflow:false,
  _historicalAttestationConflict:false, _reconciliationConflict:false,
  _revisions:[{id:H0,createdAt:ts,members:[A,B]}, {id:H1,createdAt:ts+30,members:[A,C]}] })
const audit = () => ({status:'matching-observed',allEose:true,configuredRelays:2,
  completedRelays:2,safeForPayments:false,completeHistory:false,
  relays:[0,1].map(()=>({eose:true,phase:'eose',overflow:false,saturated:false,
    conflict:false,lateEvents:false,notObservedCount:0}))})
const hex = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(data)))), b => b.toString(16).padStart(2,'0')).join('')
async function fixture() {
  const g=group(),checkpointHash=await hex({version:1,action:'acknowledge-reconciliation-v1',
    address:`30001:${A}:trip`,revisionEventId:H1,snapshotHash:S,
    participants:[A,B,C],proposedNet:[[A,50],[B,-50],[C,0]]})
  const checkpoint={hash:checkpointHash,snapshotHash:S,revisionEventId:H1,participants:[A,B,C],
    proposedNet:[[A,50],[B,-50],[C,0]],safeForPayments:false,completeHistory:false}
  const reconciliations=[A,B,C].map((m,i)=>({id:(i+2).toString(16).padStart(64,'0'),
    member:m,revisionEventId:H1,checkpointHash,snapshotHash:S,signedAt:ts+40}))
  const preview=await buildHistoricalDispositionDrafts({group:g,
    snapshot:{hash:S,revisionEventId:H1,participants:[A,B,C]},checkpoint,
    reconciliations,sourceAudit:audit(),decisionAudit:audit()})
  assert.equal(preview.status,'ready-for-review')
  return {g,checkpoint,drafts:preview.drafts}
}
const event = (g,checkpoint,draft,pubkey=A,id='f'.repeat(64)) => ({
  id,pubkey,kind:KIND_HISTORICAL_DISPOSITION_INTENT,created_at:ts+70,
  tags:historicalDispositionIntentTags(g,draft,[A,B,C]),
  content:JSON.stringify({version:1,action:'review-historical-disposition-v1',groupId:g.id,
    revisionEventId:g._revisionId,checkpointHash:checkpoint.hash,
    mode:draft.mode,draftHash:draft.draftHash}),
})

test('signed review is scoped to exact historical group, checkpoint, draft and signer',async()=>{
  const {g,checkpoint,drafts}=await fixture(),e=event(g,checkpoint,drafts[0],B)
  const parsed=parseHistoricalDispositionIntentEvent(e,g)
  assert.equal(parsed.member,B)
  assert.equal(parsed.checkpointHash,checkpoint.hash)
  assert.equal(parsed.draftHash,drafts[0].draftHash)
  assert.equal(parsed.mode,'retain-historical-record')
})
test('rejects forged member, tags, timestamp, content and revision',async()=>{
  const {g,checkpoint,drafts}=await fixture(),e=event(g,checkpoint,drafts[1])
  const invalid=[{...e,pubkey:'d'.repeat(64)},
    {...e,tags:[...e.tags,['x',drafts[1].draftHash]]},
    {...e,tags:e.tags.filter(t=>t[0]!=='p')},
    {...e,created_at:ts},
    {...e,content:e.content.replace(drafts[1].draftHash,'f'.repeat(64))},
    {...e,content:JSON.stringify({...JSON.parse(e.content),unexpected:true})},
    {...e,content:JSON.stringify({...JSON.parse(e.content),mode:'unknown'})},
    {...e,kind:9000},
  ]
  invalid.forEach(item=>assert.equal(parseHistoricalDispositionIntentEvent(item,g),null))
  assert.equal(parseHistoricalDispositionIntentEvent(e,{...g,_revisionId:'2'.repeat(64)}),null)
})
test('missing signatures remain pending; identical relay replay is idempotent',async()=>{
  const {g,checkpoint,drafts}=await fixture(),r=parseHistoricalDispositionIntentEvent(event(g,checkpoint,drafts[0]),g)
  const state=historicalDispositionIntentSummary(g,drafts,checkpoint,[r,r])
  assert.equal(state.status,'pending')
  assert.deepEqual(state.signed,[A]);assert.deepEqual(state.pending,[B,C])
  assert.equal(state.safeForPayments,false);assert.equal(state.effective,false)
})
test('all historical members including ex member may record one unanimous review',async()=>{
  const {g,checkpoint,drafts}=await fixture()
  const rows=[A,B,C].map((member,i)=>parseHistoricalDispositionIntentEvent(event(g,checkpoint,drafts[0],member,
    (i+7).toString(16).padStart(64,'0')),g))
  const result=historicalDispositionIntentSummary(g,drafts,checkpoint,rows)
  assert.equal(result.status,'unanimous-review');assert.equal(result.selectedMode,drafts[0].mode)
  assert.equal(result.effective,false);assert.equal(result.safeForPayments,false)
  assert.equal(result.completeHistory,false)
})
test('different preferences are disagreement, never silently majority-rules',async()=>{
  const {g,checkpoint,drafts}=await fixture()
  const a=parseHistoricalDispositionIntentEvent(event(g,checkpoint,drafts[0],A,'7'.repeat(64)),g)
  const b=parseHistoricalDispositionIntentEvent(event(g,checkpoint,drafts[1],B,'8'.repeat(64)),g)
  assert.equal(historicalDispositionIntentSummary(g,drafts,checkpoint,[a,b]).status,'disagreement')
})
test('multiple signed choices by same member are conflict even when identical',async()=>{
  const {g,checkpoint,drafts}=await fixture()
  const a=parseHistoricalDispositionIntentEvent(event(g,checkpoint,drafts[0],A,'7'.repeat(64)),g)
  assert.equal(historicalDispositionIntentSummary(g,drafts,checkpoint,[a,{...a,id:'8'.repeat(64)}]).status,'conflict')
  assert.equal(historicalDispositionIntentSummary(g,drafts,checkpoint,[a,{...a,member:B}]).status,'conflict')
})
test('stale and alternative draft signatures stay observable but cannot approve',async()=>{
  const {g,checkpoint,drafts}=await fixture()
  const a=parseHistoricalDispositionIntentEvent(event(g,checkpoint,drafts[0]),g)
  const wrong={...a,id:'7'.repeat(64),draftHash:'1'.repeat(64)}
  const state=historicalDispositionIntentSummary(g,drafts,checkpoint,[wrong])
  assert.equal(state.status,'conflict');assert.deepEqual(state.reasons,['alternative-draft'])
  assert.equal(historicalDispositionIntentSummary({...g,_revisionId:'2'.repeat(64)},drafts,checkpoint,[a]).status,'conflict')
  assert.equal(historicalDispositionIntentSummary(g,null,checkpoint,[a]).status,'unavailable')
})
test('oversized and invalid evidence fails closed',async()=>{
  const {g,checkpoint,drafts}=await fixture()
  assert.equal(historicalDispositionIntentSummary(g,drafts,checkpoint,new Array(201).fill(null)).status,'conflict')
  assert.equal(historicalDispositionIntentSummary(g,drafts,checkpoint,[{id:'bad'}]).status,'conflict')
})
test('all three independent relay comparisons required even for review signatures',()=>{
  assert.equal(historicalDispositionIntentReady(audit(),audit(),audit()),true)
  assert.equal(historicalDispositionIntentReady(audit(),audit(),null),false)
  assert.equal(historicalDispositionIntentReady(audit(),{...audit(),status:'divergent'},audit()),false)
  assert.equal(historicalDispositionIntentReady({...audit(),allEose:false},audit(),audit()),false)
})
test('tags reject unverified draft or participant substitution',async()=>{
  const {g,drafts}=await fixture()
  assert.throws(()=>historicalDispositionIntentTags(g,drafts[0],[A,C]),/non valida/)
  assert.throws(()=>historicalDispositionIntentTags(g,{...drafts[0],draftHash:'x'},[A,B,C]),/non valida/)
})
