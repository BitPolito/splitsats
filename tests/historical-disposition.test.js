import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHistoricalDispositionDrafts } from '../src/lib/historical-disposition.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)
const H0 = '0'.repeat(64), H1 = '1'.repeat(64), S = 'e'.repeat(64)
const now = Math.floor(Date.now()/1000)
const group = () => ({ id: 'trip', pubkey: A, members: [A,C],
  _revisionId: H1, _revisionStatus:'verified',
  _financialReviewRequired:true, _priorHistoryChecked:true,
  _historicalActivityDetected:true, _reconciliationDecisionsChecked:true,
  _priorReplayOverflow:false, _priorEvidenceOverflow:false,
  _historicalAttestationConflict:false, _reconciliationConflict:false,
  _revisions:[{id:H0,createdAt:now-120,members:[A,B]},
    {id:H1,createdAt:now-90,members:[A,C]}] })
const snapshot = () => ({hash:S, revisionEventId:H1, participants:[A,B,C]})
const audit = () => ({status:'matching-observed',allEose:true,configuredRelays:2,
  completedRelays:2,safeForPayments:false,completeHistory:false,
  relays:[0,1].map(()=>({eose:true,phase:'eose',overflow:false,
    saturated:false,conflict:false,lateEvents:false,notObservedCount:0}))})
const hex = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(value)))), b => b.toString(16).padStart(2,'0')).join('')
async function inputs(vector = [[A,50],[B,-50],[C,0]]) {
  const g=group(), s=snapshot(), checkpointHash=await hex({version:1,action:'acknowledge-reconciliation-v1',
    address:`30001:${A}:trip`,revisionEventId:H1,snapshotHash:S,
    participants:[A,B,C],proposedNet:vector})
  const checkpoint={hash:checkpointHash,snapshotHash:S,revisionEventId:H1,
    participants:[A,B,C],proposedNet:vector,safeForPayments:false,completeHistory:false}
  const reconciliations=[A,B,C].map((m,i)=>({id:(i+2).toString(16).padStart(64,'0'),
    member:m,revisionEventId:H1,checkpointHash, snapshotHash:S,signedAt:now-60}))
  return {group:g,snapshot:s,checkpoint,reconciliations,sourceAudit:audit(),decisionAudit:audit(),conflict:false}
}
const run = arg => buildHistoricalDispositionDrafts(arg)

test('unanimous checkpoint yields two immutable, historical-only drafts',async()=>{
  const r=await run(await inputs())
  assert.equal(r.status,'ready-for-review')
  assert.equal(r.drafts.length,2)
  assert.deepEqual(r.drafts.map(d=>d.mode),['retain-historical-record','propose-mutual-waiver'])
  assert.deepEqual(r.drafts[0].proposedNet,[[A,50],[B,-50],[C,0]])
  assert.deepEqual(r.drafts[1].proposedNet,[[A,0],[B,0],[C,0]])
  assert.notEqual(r.drafts[0].draftHash,r.drafts[1].draftHash)
  assert.equal(r.safeForPayments,false)
  assert.equal(r.effective,false)
  assert.equal(r.completeHistory,false)
  assert.ok(r.drafts.every(d=>!d.effective && !d.safeForPayments && d.requiresIndependentAgreement))
  assert.ok(Object.isFrozen(r.drafts[1].proposedNet[0]))
})

test('deterministic draft hashes and historical roster including removed member',async()=>{
  const arg=await inputs(),a=await run(arg),b=await run(arg)
  assert.equal(a.drafts[0].draftHash,b.drafts[0].draftHash)
  assert.equal(a.drafts[0].participantCount,3)
  assert.deepEqual(a.drafts[0].historicalNet.map(r=>r[0]),[A,B,C])
})

test('missing signatures never produces preview, even if two relays EOSE',async()=>{
  const arg=await inputs()
  const r=await run({...arg,reconciliations:arg.reconciliations.slice(0,2)})
  assert.equal(r.status,'unavailable')
  assert.equal(r.reason,'unanimous-reconciliation-not-established')
})

test('conflicting signer is quarantined; no silent supersession',async()=>{
  const arg=await inputs(),double={...arg.reconciliations[0],id:'d'.repeat(64)}
  const r=await run({...arg,reconciliations:[...arg.reconciliations,double]})
  assert.equal(r.status,'unavailable')
})

test('explicit conflict flag refuses both proposals',async()=>{
  const arg=await inputs()
  assert.equal((await run({...arg,conflict:true})).status,'unavailable')
  assert.equal((await run({...arg,group:{...arg.group,_reconciliationConflict:true}})).status,'unavailable')
})

test('a source or decision relay mismatch blocks previews',async()=>{
  const arg=await inputs()
  for(const key of ['sourceAudit','decisionAudit']) {
    for(const state of [null,{...audit(),status:'divergent'},
      {...audit(),relays:audit().relays.map((x,i)=>i ? {...x,lateEvents:true}:x)},
      {...audit(),allEose:false}]) {
      const r=await run({...arg,[key]:state})
      assert.equal(r.status,'unavailable')
      assert.equal(r.reason,'relay-snapshots-not-matching')
    }
  }
})

test('new revision invalidates proposal instead of carrying claims forward',async()=>{
  const arg=await inputs()
  assert.equal((await run({...arg,group:{...arg.group,_revisionId:'f'.repeat(64)}})).status,'unavailable')
})

test('old head, wrong snapshot and forged source hash fail closed',async()=>{
  const arg=await inputs()
  for(const changes of [
    {snapshot:{...arg.snapshot,hash:'f'.repeat(64)}},
    {checkpoint:{...arg.checkpoint,snapshotHash:'b'.repeat(64)}},
    {checkpoint:{...arg.checkpoint,hash:'c'.repeat(64)}},
  ]) assert.equal((await run({...arg,...changes})).status,'unavailable')
})

test('local mutation of numbers cannot borrow signatures on original checkpoint',async()=>{
  const arg=await inputs()
  const forged={...arg.checkpoint,proposedNet:[[A,70],[B,-70],[C,0]]}
  const r=await run({...arg,checkpoint:forged})
  assert.equal(r.status,'unavailable')
  assert.equal(r.reason,'checkpoint-net-hash-mismatch')
})

test('rejects unsafe, malformed, unbalanced, oversized, and unsorted net vectors',async()=>{
  const bad=[[[A,25],[B,-24],[C,0]],[[A,25.5],[B,-25.5],[C,0]],
    [[A,2_100_000_000_000_001],[B,-2_100_000_000_000_001],[C,0]],
    [[B,-25],[A,25],[C,0]],[[A,25],[B,-25]],[[A,25],[B,-25],[C,0],[A,0]]]
  for(const vector of bad) {
    const arg=await inputs(vector),result=await run(arg)
    assert.equal(result.status,'unavailable')
    assert.equal(result.reason,'invalid-historical-net-vector')
  }
})

test('history gaps and financial lock removal cannot create a draft',async()=>{
  const arg=await inputs()
  for(const mutation of [{_priorReplayOverflow:true},{_priorEvidenceOverflow:true},
    {_historicalAttestationConflict:true},{_financialReviewRequired:false},
    {_priorHistoryChecked:false},{_reconciliationDecisionsChecked:false},
    {_historicalActivityDetected:false},{_revisionStatus:'pending'}]) {
    assert.equal((await run({...arg,group:{...arg.group,...mutation}})).status,'unavailable')
  }
})

test('no historical participants and incomplete ledger are not silently treated as zero debts',async()=>{
  const arg=await inputs()
  assert.equal((await run({...arg,group:{...arg.group,_revisions:[]}})).status,'unavailable')
  assert.equal((await run({...arg,checkpoint:null})).status,'unavailable')
  assert.equal((await run({})).status,'unavailable')
})

test('different agreed source net produces different draft hashes',async()=>{
  const a=await run(await inputs())
  const b=await run(await inputs([[A,60],[B,-60],[C,0]]))
  assert.equal(b.status,'ready-for-review')
  assert.notEqual(a.drafts[0].draftHash,b.drafts[0].draftHash)
})
