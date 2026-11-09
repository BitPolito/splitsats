import test from 'node:test'
import assert from 'node:assert/strict'
import { buildHistoricalDispositionDrafts } from '../src/lib/historical-disposition.js'
import {
  historicalReviewStatus, buildHistoricalReviewRecord,
} from '../src/lib/historical-review-record.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)
const H0 = '0'.repeat(64), H1 = '1'.repeat(64), S = 'e'.repeat(64)
const ts = Math.floor(Date.now() / 1000) - 150
const group = () => ({ id: 'trip', pubkey: A, members: [A,C],
  _revisionId: H1, _revisionStatus: 'verified', _financialReviewRequired: true,
  _priorHistoryChecked: true, _historicalActivityDetected: true,
  _reconciliationDecisionsChecked: true, _priorReplayOverflow: false,
  _priorEvidenceOverflow: false, _historicalAttestationConflict: false,
  _reconciliationConflict: false,
  _revisions: [{ id: H0, createdAt: ts, members: [A,B] },
    { id: H1, createdAt: ts+30, members: [A,C] }] })
const audit = () => ({ status: 'matching-observed', allEose: true,
  configuredRelays: 2, completedRelays: 2,
  safeForPayments: false, completeHistory: false,
  relays: [0,1].map(() => ({eose:true,phase:'eose',overflow:false,
    saturated:false,conflict:false,lateEvents:false,notObservedCount:0})) })
const sha = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(JSON.stringify(value)))), b => b.toString(16).padStart(2, '0')).join('')

async function fixture(mode = 'retain-historical-record') {
  const g = group(), snapshot = { hash:S, revisionEventId:H1, participants:[A,B,C] }
  const vector = [[A,50],[B,-50],[C,0]]
  const checkpointHash = await sha({ version:1, action:'acknowledge-reconciliation-v1',
    address:`30001:${A}:trip`, revisionEventId:H1, snapshotHash:S,
    participants:[A,B,C], proposedNet:vector })
  const checkpoint = { hash: checkpointHash, snapshotHash:S, revisionEventId:H1,
    participants:[A,B,C], proposedNet:vector, safeForPayments:false, completeHistory:false }
  const reconciliations = [A,B,C].map((m,i) => ({
    id: (i+2).toString(16).padStart(64,'0'), member:m, revisionEventId:H1,
    snapshotHash:S, checkpointHash, signedAt:ts+60 }))
  const sourceAudit = audit(), decisionAudit = audit(), intentAudit = audit()
  const data = { group:g, snapshot, checkpoint, reconciliations,
    sourceAudit, decisionAudit, intentAudit }
  const preview = await buildHistoricalDispositionDrafts({...data})
  assert.equal(preview.status, 'ready-for-review')
  const draft = preview.drafts.find(d => d.mode === mode)
  const intents = [A,B,C].map((member,i) => ({
    id: (i+7).toString(16).padStart(64,'0'), member, signedAt: ts+70,
    revisionEventId:H1, checkpointHash, draftHash:draft.draftHash, mode }))
  return { ...data, preview, drafts: preview.drafts, intents }
}
const status = f => historicalReviewStatus({ ...f, drafts:f.drafts })
const record = f => buildHistoricalReviewRecord(f)

test('unanimous verified historical review creates only a nonbinding local fingerprint', async () => {
  const f = await fixture(), r = await record(f)
  assert.equal(status(f).status, 'review-recorded')
  assert.equal(r.status, 'review-recorded')
  assert.match(r.record.recordHash, /^[0-9a-f]{64}$/)
  assert.deepEqual(r.record.signedEvents, [[A,f.intents[0].id],[B,f.intents[1].id],[C,f.intents[2].id]])
  for(const obj of [r,r.record]) {
    assert.equal(obj.safeForPayments, false)
    assert.equal(obj.completeHistory, false)
    assert.equal(obj.effective, false)
    assert.equal(obj.legalWaiver, false)
  }
  assert.equal(r.ledgerMutationAllowed, false)
  assert.equal(Object.isFrozen(r.record.signedEvents), true)
})

test('repeated relay observations do not change evidence fingerprint', async () => {
  const f=await fixture(), initial=await record(f)
  const replay=await record({...f,intents:[f.intents[2],f.intents[0],...f.intents,f.intents[1]]})
  assert.equal(replay.status,'review-recorded')
  assert.equal(replay.record.recordHash,initial.record.recordHash)
})

test('same signed preference with another verified event ID changes fingerprint',async()=>{
  const f=await fixture(), a=await record(f)
  const intents=f.intents.map((r,i)=>i===1?{...r,id:'f'.repeat(64)}:r)
  const b=await record({...f,intents})
  assert.equal(b.status,'review-recorded')
  assert.notEqual(a.record.recordHash,b.record.recordHash)
})

test('unanimous waiver proposal remains a review of preference, never debt release',async()=>{
  const f=await fixture('propose-mutual-waiver'), r=await record(f)
  assert.equal(r.status,'review-recorded')
  assert.equal(r.record.mode,'propose-mutual-waiver')
  assert.equal(r.record.effective,false)
  assert.equal(r.record.legalWaiver,false)
})

test('missing current or former-member signatures are pending and produce no record',async()=>{
  const f=await fixture()
  for(const intents of [[],f.intents.slice(0,1),[f.intents[0],f.intents[2]]]) {
    const r=await record({...f,intents})
    assert.equal(r.status,'pending')
    assert.equal(r.record,null)
    assert.equal(r.effective,false)
  }
})

test('different independently signed preferences yield disagreement rather than finality',async()=>{
  const f=await fixture(), other=f.drafts.find(d=>d.mode==='propose-mutual-waiver')
  const intents=f.intents.map((r,i)=>i===1?{...r,mode:other.mode,draftHash:other.draftHash}:r)
  const r=await record({...f,intents})
  assert.equal(r.status,'disagreement')
  assert.equal(r.record,null)
})

test('duplicate signer even on same mode is conflict, not renewed consent',async()=>{
  const f=await fixture()
  const intents=[...f.intents,{...f.intents[0],id:'f'.repeat(64)}]
  const r=await record({...f,intents})
  assert.equal(r.status,'conflict')
  assert.equal(r.record,null)
})

test('divergent envelope sharing an event ID fails closed',async()=>{
  const f=await fixture()
  const intents=[...f.intents,{...f.intents[0],signedAt:f.intents[0].signedAt+1}]
  const r=await record({...f,intents})
  assert.equal(r.status,'conflict')
  assert.equal(r.record,null)
})

test('explicit source or intent conflict suppresses the fingerprint',async()=>{
  const f=await fixture()
  for(const prop of ['conflict','intentConflict']) {
    const r=await record({...f,[prop]:true})
    assert.equal(r.status,'conflict')
    assert.equal(r.record,null)
  }
})

test('relay disconnect, missing EOSE and different observations remove readiness',async()=>{
  const f=await fixture()
  for(const key of ['sourceAudit','decisionAudit','intentAudit']) {
    for(const bad of [null,{...audit(),status:'divergent'},
      {...audit(),allEose:false},
      {...audit(),relays:audit().relays.map((r,i)=>i?{...r,lateEvents:true}:r)}]) {
      const r=await record({...f,[key]:bad})
      assert.equal(r.record,null)
      assert.equal(r.safeForPayments,false)
      assert.notEqual(r.status,'review-recorded')
    }
  }
})

test('revision changed since signing never carries a preference to a new head',async()=>{
  const f=await fixture(), group={...f.group,_revisionId:'f'.repeat(64)}
  const r=await record({...f,group})
  assert.notEqual(r.status,'review-recorded')
  assert.equal(r.record,null)
})

test('tampered checkpoint net cannot borrow signed review preferences',async()=>{
  const f=await fixture(), checkpoint={...f.checkpoint,
    proposedNet:[[A,51],[B,-51],[C,0]]}
  const r=await record({...f,checkpoint})
  assert.equal(r.record,null)
  assert.equal(r.status,'unavailable')
})

test('no historical chain or released financial barrier never creates a record',async()=>{
  const f=await fixture()
  for(const group of [{...f.group,_revisions:[]},
    {...f.group,_financialReviewRequired:false},
    {...f.group,_priorReplayOverflow:true},
    {...f.group,_reconciliationDecisionsChecked:false}]) {
    const r=await record({...f,group})
    assert.equal(r.record,null)
    assert.equal(r.safeForPayments,false)
  }
  assert.equal((await record()).record,null)
})
