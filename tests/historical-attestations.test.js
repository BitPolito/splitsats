import test from 'node:test'
import assert from 'node:assert/strict'
import { KIND_HISTORICAL_ATTESTATION } from '../src/lib/constants.js'
import { historicalAttestationParticipants, buildHistoricalAttestationSnapshot,
  historicalAttestationTags, parseHistoricalAttestationEvent,
  historicalAttestationSummary } from '../src/lib/historical-attestations.js'
const A='a'.repeat(64), B='b'.repeat(64), C='c'.repeat(64)
const H0='0'.repeat(64),H1='1'.repeat(64), E='e'.repeat(64),F='f'.repeat(64)
const t=Math.floor(Date.now()/1000)-200
const group=()=>({id:'trip',pubkey:A,members:[A,C],_revisionId:H1,_revisionStatus:'verified',
  _priorHistoryChecked:true,_historicalActivityDetected:true,_priorReplayOverflow:false,_priorEvidenceOverflow:false,
  _revisions:[{id:H0,createdAt:t,members:[A,B]},{id:H1,createdAt:t+50,members:[A,C]}]})
const replay=()=>({status:'observed',safeForPayments:false,observedNet:{[A]:25,[B]:-25,[C]:0}})
const events=()=>[{id:E,pubkey:B,kind:9000,created_at:t+10,content:'{}',tags:[]}]
const fakeEvent=(g,s,member,id=F)=>({id,pubkey:member,kind:KIND_HISTORICAL_ATTESTATION,
  created_at:t+60,tags:historicalAttestationTags(g,s),content:JSON.stringify({
    action:'attest-historical-v1',version:1,groupId:g.id,revisionEventId:g._revisionId,snapshotHash:s.hash})})

test('roster includes removed members and stays deterministic',()=>{
  assert.deepEqual(historicalAttestationParticipants(group()),[A,B,C])
})
test('snapshot commits to event IDs, participants and observed signed balances',async()=>{
  const g=group(),s=await buildHistoricalAttestationSnapshot(g,events(),replay())
  assert.match(s.hash,/^[0-9a-f]{64}$/)
  assert.deepEqual(s.participants,[A,B,C])
  assert.equal(s.safeForPayments,false)
  const extra=[...events(),{...events()[0],id:'1'.repeat(64)}]
  const other=await buildHistoricalAttestationSnapshot(g,extra,replay())
  assert.notEqual(other.hash,s.hash)
  const modified=await buildHistoricalAttestationSnapshot(g,events(),{...replay(),observedNet:{[A]:24,[B]:-24,[C]:0}})
  assert.notEqual(modified.hash,s.hash)
})
test('snapshot independent of event order or exact replay duplicates',async()=>{
  const g=group(),set=[...events(),{...events()[0],id:'1'.repeat(64)}]
  const a=await buildHistoricalAttestationSnapshot(g,set,replay())
  const b=await buildHistoricalAttestationSnapshot(g,[set[1],set[0],set[0]],replay())
  assert.equal(a.hash,b.hash)
})
test('missing EOSE, replay conflict or overflow refuse snapshot',async()=>{
  const g=group()
  for(const change of [{_priorHistoryChecked:false},{_priorEvidenceOverflow:true},
    {_priorReplayOverflow:true},{_historicalActivityDetected:false},{_revisionStatus:'pending'}]){
    assert.equal(await buildHistoricalAttestationSnapshot({...g,...change},events(),replay()),null)
  }
  assert.equal(await buildHistoricalAttestationSnapshot(g,events(),{...replay(),status:'incomplete'}),null)
  assert.equal(await buildHistoricalAttestationSnapshot(g,events(),{...replay(),safeForPayments:true}),null)
  assert.equal(await buildHistoricalAttestationSnapshot(g,[],replay()),null)
})
test('invalid or unbalanced observedNet is rejected',async()=>{
  for(const net of [{[A]:1,[B]:-1},{[A]:1,[B]:-2,[C]:0},{[A]:1.5,[B]:-1.5,[C]:0},
    {[A]:Number.MAX_SAFE_INTEGER,[B]:-Number.MAX_SAFE_INTEGER,[C]:2}]){
    assert.equal(await buildHistoricalAttestationSnapshot(group(),events(),{...replay(),observedNet:net}),null)
  }
})
test('historical author can sign exact current-head snapshot, unauthorised cannot',async()=>{
  const g=group(),s=await buildHistoricalAttestationSnapshot(g,events(),replay())
  const signed=fakeEvent(g,s,B)
  assert.deepEqual(parseHistoricalAttestationEvent(signed,g),{
    id:F,member:B,snapshotHash:s.hash,revisionEventId:H1,signedAt:t+60})
  assert.equal(parseHistoricalAttestationEvent({...signed,pubkey:'d'.repeat(64)},g),null)
})
test('forged content, duplicate tags, wrong head and stale timestamps fail closed',async()=>{
  const g=group(),s=await buildHistoricalAttestationSnapshot(g,events(),replay()),valid=fakeEvent(g,s,B)
  assert.equal(parseHistoricalAttestationEvent({...valid,tags:[...valid.tags,['x',s.hash]]},g),null)
  assert.equal(parseHistoricalAttestationEvent({...valid,created_at:t+10},g),null)
  assert.equal(parseHistoricalAttestationEvent({...valid,content:valid.content.replace(s.hash,H0)},g),null)
  assert.equal(parseHistoricalAttestationEvent({...valid,tags:valid.tags.filter(t=>t[0]!=='p')},g),null)
  assert.equal(parseHistoricalAttestationEvent({...valid,content:JSON.stringify({oops:true})},g),null)
})
test('only unanimous matching snapshots reach attested, still never unlock payment',async()=>{
  const g=group(),s=await buildHistoricalAttestationSnapshot(g,events(),replay())
  const rows=[A,B,C].map((m,i)=>parseHistoricalAttestationEvent(fakeEvent(g,s,m,(i+3).toString(16).padStart(64,'0')),g))
  assert.equal(historicalAttestationSummary(g,s,rows.slice(0,2)).status,'pending')
  const done=historicalAttestationSummary(g,s,rows)
  assert.equal(done.status,'attested');assert.equal(done.safeForPayments,false)
  assert.deepEqual(done.pending,[])
})
test('a signers duplicate or divergent hash becomes a conflict',async()=>{
  const g=group(),s=await buildHistoricalAttestationSnapshot(g,events(),replay())
  const first=parseHistoricalAttestationEvent(fakeEvent(g,s,A),g)
  const changed={...first,id:'2'.repeat(64),snapshotHash:H0}
  assert.equal(historicalAttestationSummary(g,s,[first,changed]).status,'conflict')
  assert.equal(historicalAttestationSummary(g,s,[{...first,snapshotHash:H0}]).status,'conflict')
})
test('replay of identical signed ID is idempotent for status',async()=>{
  const g=group(),s=await buildHistoricalAttestationSnapshot(g,events(),replay())
  const row=parseHistoricalAttestationEvent(fakeEvent(g,s,A),g)
  assert.equal(historicalAttestationSummary(g,s,[row,row]).status,'pending')
  assert.equal(historicalAttestationSummary(g,s,[row,{...row,id:row.id,member:B}]).status,'conflict')
})
test('new head invalidates the old snapshot and old attestation',async()=>{
  const g=group(),s=await buildHistoricalAttestationSnapshot(g,events(),replay())
  const next={...g,_revisionId:'9'.repeat(64)}
  assert.equal(historicalAttestationSummary(next,s,[]).status,'unavailable')
  assert.equal(parseHistoricalAttestationEvent(fakeEvent(g,s,A),next),null)
})

test('same immutable source event ID with divergent envelope invalidates snapshot',async()=>{
  const original=events()[0]
  const bad={...original,kind:9001}
  assert.equal(await buildHistoricalAttestationSnapshot(group(),[original,bad],replay()),null)
})
