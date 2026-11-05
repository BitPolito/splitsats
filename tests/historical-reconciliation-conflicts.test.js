import test from 'node:test'
import assert from 'node:assert/strict'
import { historicalReconciliationConflicts, historicalReconciliationSummary } from '../src/lib/historical-reconciliation.js'

const A='a'.repeat(64), B='b'.repeat(64), C='c'.repeat(64)
const H0='0'.repeat(64), H1='1'.repeat(64), SNAP='e'.repeat(64), CHECK='f'.repeat(64)
const t=Math.floor(Date.now()/1000)-100
const group=()=>({id:'trip',pubkey:A,members:[A,C],_revisionId:H1,_revisionStatus:'verified',
  _revisions:[{id:H0,createdAt:t,members:[A,B]},{id:H1,createdAt:t+10,members:[A,C]}]})
const checkpoint=()=>({hash:CHECK,snapshotHash:SNAP,revisionEventId:H1,participants:[A,B,C]})
const ack=(member,id,override={})=>({id:id.toString(16).padStart(64,'0'),member,
  snapshotHash:SNAP,checkpointHash:CHECK,revisionEventId:H1,signedAt:t+20,...override})

test('identical Nostr event replays are idempotent, never alternative signatures',()=>{
  const row=ack(A,1),result=historicalReconciliationConflicts(group(),checkpoint(),[row,row])
  assert.equal(result.status,'pending')
  assert.equal(result.signatureCount,1)
  assert.deepEqual(result.reasons,[])
  assert.equal(result.safeForPayments,false)
})
test('two distinct signatures from the same participant are surfaced as a conflict',()=>{
  const result=historicalReconciliationConflicts(group(),checkpoint(),[ack(A,1),ack(A,2)])
  assert.equal(result.status,'conflict')
  assert.deepEqual(result.doubleSigners,[A])
  assert.ok(result.reasons.includes('multiple-signatures'))
})
test('alternative hashes are visible as evidence, but never become authorised debt',()=>{
  const altered='d'.repeat(64)
  const result=historicalReconciliationConflicts(group(),checkpoint(),[ack(A,1),ack(B,2,{checkpointHash:altered})])
  assert.equal(result.status,'conflict')
  assert.deepEqual(result.competingCheckpointHashes,[altered])
  assert.equal(result.safeForPayments,false)
  assert.equal(result.completeHistory,false)
})
test('divergent source snapshot signatures are called out separately',()=>{
  const newSnap='d'.repeat(64)
  const result=historicalReconciliationConflicts(group(),checkpoint(),[ack(A,1,{snapshotHash:newSnap})])
  assert.equal(result.status,'conflict')
  assert.deepEqual(result.competingSnapshotHashes,[newSnap])
})
test('same signed event ID with inconsistent parsed fields is a conflict',()=>{
  const result=historicalReconciliationConflicts(group(),checkpoint(),[ack(A,1),ack(B,1)])
  assert.equal(result.status,'conflict')
  assert.ok(result.reasons.includes('same-id-different-envelope'))
})
test('unavailable checkpoint retains historical vote evidence without calling it agreed',()=>{
  const result=historicalReconciliationConflicts(group(),null,[ack(A,1)])
  assert.equal(result.status,'unavailable')
  assert.equal(result.signatureCount,1)
  assert.equal(result.safeForPayments,false)
})
test('different revision head never inherits prior acknowledgements',()=>{
  const result=historicalReconciliationConflicts({...group(),_revisionId:H0},checkpoint(),[ack(A,1)])
  assert.equal(result.status,'conflict')
  assert.ok(result.reasons.includes('stale-revision'))
})
test('unanimous matching votes are only a nonpayable agreement',()=>{
  const rows=[ack(A,1),ack(B,2),ack(C,3)]
  const result=historicalReconciliationConflicts(group(),checkpoint(),rows)
  assert.equal(result.status,'agreed')
  assert.equal(historicalReconciliationSummary(group(),checkpoint(),rows).status,'agreed')
  assert.equal(result.safeForPayments,false)
})
test('malformed and overlarge vote collections stay fail-closed',()=>{
  const g=group(),c=checkpoint()
  assert.equal(historicalReconciliationConflicts(g,c,[{...ack(A,1),id:'bad'}]).status,'conflict')
  assert.ok(historicalReconciliationConflicts(g,c,Array.from({length:201},(_,i)=>ack(A,i+1))).reasons.includes('over-limit'))
})
test('competing hashes are sampled at a fixed upper bound',()=>{
  const rows=Array.from({length:14},(_,i)=>ack(A,i+1,{checkpointHash:(i+1).toString(16).padStart(64,'0')}))
  const result=historicalReconciliationConflicts(group(),checkpoint(),rows)
  assert.equal(result.status,'conflict')
  assert.equal(result.competingCheckpointCount,14)
  assert.equal(result.competingCheckpointHashes.length,8)
})
