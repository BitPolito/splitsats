import test from 'node:test'
import assert from 'node:assert/strict'
import { KIND_HISTORICAL_RECONCILIATION } from '../src/lib/constants.js'
import {
  buildHistoricalReconciliationCheckpoint, historicalReconciliationTags,
  parseHistoricalReconciliationEvent, historicalReconciliationSummary,
  reconciliationRelayReady,
} from '../src/lib/historical-reconciliation.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)
const H0 = '0'.repeat(64), H1 = '1'.repeat(64), S = 'e'.repeat(64)
const ts = Math.floor(Date.now() / 1000) - 150
const group = () => ({ id: 'trip', pubkey: A, members: [A, C], _revisionId: H1,
  _revisionStatus: 'verified', _priorHistoryChecked: true, _reconciliationDecisionsChecked: true,
  _historicalActivityDetected: true, _financialReviewRequired: true,
  _priorReplayOverflow: false, _priorEvidenceOverflow: false,
  _revisions: [{ id: H0, createdAt: ts, members: [A,B] },
    { id: H1, createdAt: ts+30, members: [A,C] }] })
const snapshot = () => ({ hash: S, revisionEventId: H1, participants: [A,B,C] })
const attestations = () => [A,B,C].map((m,i) => ({
  id: (i+2).toString(16).padStart(64, '0'), member:m,
  snapshotHash:S, revisionEventId:H1, signedAt:ts+50 }))
const audit = () => ({ status:'matching-observed', allEose:true, configuredRelays:2,
  completedRelays:2, safeForPayments:false, completeHistory:false,
  relays:[{eose:true,phase:'eose',overflow:false,saturated:false,conflict:false,lateEvents:false,notObservedCount:0},
    {eose:true,phase:'eose',overflow:false,saturated:false,conflict:false,lateEvents:false,notObservedCount:0}] })
const replay = () => ({ status:'observed', safeForPayments:false,
  observedNet: {[A]: 40, [B]: -40, [C]: 0} })
const build = (g=group(), s=snapshot(), r=replay(), a=audit(), att=attestations()) =>
  buildHistoricalReconciliationCheckpoint(g,s,r,a,att)
const signedEvent = (c, m=A, id='f'.repeat(64)) => ({
  id, pubkey:m, kind:KIND_HISTORICAL_RECONCILIATION, created_at:ts+70,
  tags:historicalReconciliationTags(group(),c),
  content: JSON.stringify({ version:1, action:'acknowledge-reconciliation-v1', groupId:'trip',
    revisionEventId:H1, snapshotHash:c.snapshotHash, checkpointHash:c.hash }),
})

test('proposal binds current head, source snapshot, exact satoshis and former members', async () => {
  const c=await build()
  assert.match(c.hash,/^[0-9a-f]{64}$/)
  assert.deepEqual(c.participants,[A,B,C])
  assert.deepEqual(c.proposedNet,[[A,40],[B,-40],[C,0]])
  assert.equal(c.safeForPayments,false)
  assert.equal(c.completeHistory,false)
  assert.notEqual((await build(group(),snapshot(),{...replay(),observedNet:{[A]:41,[B]:-41,[C]:0}})).hash,c.hash)
  assert.notEqual((await build(group(),{...snapshot(),hash:'d'.repeat(64)},replay(),audit(),
    attestations().map(x=>({...x,snapshotHash:'d'.repeat(64)})))).hash,c.hash)
})
test('unsigned, incomplete or conflicting snapshot attestations do not produce checkpoints', async () => {
  assert.equal(await build(group(),snapshot(),replay(),audit(),attestations().slice(0,2)),null)
  assert.equal(await build(group(),snapshot(),replay(),audit(),[...attestations(), {...attestations()[0], id: H0}]),null)
  assert.equal(await build({...group(),_historicalAttestationConflict:true}),null)
  assert.equal(await build({...group(),_financialReviewRequired:false}),null)
  assert.equal(await build({...group(),_reconciliationDecisionsChecked:false}),null)
})
test('divergent, pending, truncated, one-relay and stale snapshots are not eligible',async()=>{
  for(const mutated of [
    {...audit(),status:'divergent'}, {...audit(),allEose:false},
    {...audit(),configuredRelays:1,completedRelays:1,relays:audit().relays.slice(0,1)},
    {...audit(),relays:audit().relays.map((x,i)=>i ? {...x,lateEvents:true}:x)},
    {...audit(),relays:audit().relays.map((x,i)=>i ? {...x,notObservedCount:1}:x)},
    {...audit(),relays:audit().relays.map((x,i)=>i ? {...x,saturated:true}:x)},
  ]) {
    assert.equal(reconciliationRelayReady(mutated), false)
    assert.equal(await build(group(),snapshot(),replay(),mutated),null)
  }
})
test('rejects unbalanced, noninteger, oversize and unknown net participants',async()=>{
  for(const net of [
    {[A]:40,[B]:-41,[C]:0}, {[A]:40.5,[B]:-40.5,[C]:0},
    {[A]:2_100_000_000_000_001,[B]:-2_100_000_000_000_001,[C]:0},
    {[A]:40,[B]:-40}, {[A]:40,[B]:-40,[C]:0,['d'.repeat(64)]:0},
  ]) assert.equal(await build(group(),snapshot(),{...replay(),observedNet:net}),null)
})
test('signed event only accepts exact author, tags, revision and content hash',async()=>{
  const c=await build(),e=signedEvent(c,B)
  assert.equal(parseHistoricalReconciliationEvent(e,group())?.member,B)
  assert.equal(parseHistoricalReconciliationEvent({...e,pubkey:'d'.repeat(64)},group()),null)
  assert.equal(parseHistoricalReconciliationEvent({...e,tags:[...e.tags,['r',H1]]},group()),null)
  assert.equal(parseHistoricalReconciliationEvent({...e,tags:e.tags.filter(t=>t[0]!=='p')},group()),null)
  assert.equal(parseHistoricalReconciliationEvent({...e,content:e.content.replace(c.hash,H0)},group()),null)
  assert.equal(parseHistoricalReconciliationEvent({...e,created_at:ts+5},group()),null)
  assert.equal(parseHistoricalReconciliationEvent({...e,content:JSON.stringify({version:1,evil:1})},group()),null)
  assert.equal(parseHistoricalReconciliationEvent(e,{...group(),_revisionId:H0}),null)
})
test('unanimous same-checkpoint acknowledgement remains nonpayable',async()=>{
  const c=await build(),g=group()
  const rows=[A,B,C].map((m,i)=>parseHistoricalReconciliationEvent(signedEvent(c,m,(i+12).toString(16).padStart(64,'0')),g))
  assert.equal(historicalReconciliationSummary(g,c,rows.slice(0,2)).status,'pending')
  const result=historicalReconciliationSummary(g,c,rows)
  assert.equal(result.status,'agreed')
  assert.equal(result.safeForPayments,false)
  assert.equal(result.completeHistory,false)
})
test('replay idempotent, competing signatures or stale checkpoints fail closed',async()=>{
  const c=await build(),g=group(),row=parseHistoricalReconciliationEvent(signedEvent(c,A),g)
  assert.equal(historicalReconciliationSummary(g,c,[row,row]).status,'pending')
  assert.equal(historicalReconciliationSummary(g,c,[row,{...row,id:H0}]).status,'conflict')
  assert.equal(historicalReconciliationSummary(g,c,[row,{...row,id:H0,member:B,checkpointHash:H0}]).status,'conflict')
  assert.equal(historicalReconciliationSummary(g,{...c,hash:H0},[row]).status,'conflict')
  assert.equal(historicalReconciliationSummary({...g,_revisionId:H0},c,[row]).status,'unavailable')
  assert.equal(historicalReconciliationSummary(g,c,[row,{...row,member:B}]).status,'conflict')
})
