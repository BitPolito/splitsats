import test from 'node:test'
import assert from 'node:assert/strict'
import { RelaySnapshotAudit, MAX_AUDIT_IDS_PER_RELAY } from '../src/lib/relay-snapshot-audit.js'
import { reconciliationRelayReady } from '../src/lib/historical-reconciliation.js'

const A = 'a'.repeat(64)
const relays = ['wss://one.test', 'wss://two.test']
const ev = n => ({id:n.toString(16).padStart(64,'0'),pubkey:A,
  created_at:100,kind:9597,content:'{}',tags:[],sig:'f'.repeat(128)})

test('decision votes require matching observed snapshots after all EOSEs',()=>{
  const a = new RelaySnapshotAudit(relays)
  a.record(relays[0],ev(1));a.record(relays[1],ev(1))
  a.eose(relays[0])
  assert.equal(reconciliationRelayReady(a.report()),false)
  a.eose(relays[1])
  assert.equal(reconciliationRelayReady(a.report()),true)
  assert.equal(a.report().safeForPayments,false)
})
test('divergent decision histories block further signing',()=>{
  const a = new RelaySnapshotAudit(relays)
  a.record(relays[0],ev(1)); a.record(relays[1],ev(2))
  a.eose(relays[0]);a.eose(relays[1])
  assert.equal(a.report().status,'divergent')
  assert.equal(reconciliationRelayReady(a.report()),false)
})
test('disconnect, reconnect and post-EOSE votes invalidate previous readiness',()=>{
  const a = new RelaySnapshotAudit(relays)
  relays.forEach(url=>a.eose(url))
  assert.equal(reconciliationRelayReady(a.report()),true)
  a.reset(relays[1],'disconnected')
  assert.equal(reconciliationRelayReady(a.report()),false)
  a.reset(relays[1],'connected');a.eose(relays[1])
  assert.equal(reconciliationRelayReady(a.report()),true)
  a.record(relays[0],ev(1))
  assert.equal(a.report().status,'changed-after-eose')
  assert.equal(reconciliationRelayReady(a.report()),false)
})
test('at the relay query cap, matching truncated snapshots cannot authorize another signature',()=>{
  const a = new RelaySnapshotAudit(relays)
  for(const url of relays){
    for(let i=1;i<=MAX_AUDIT_IDS_PER_RELAY;i++)a.record(url,ev(i))
    a.eose(url)
  }
  assert.equal(a.report().status,'at-limit')
  assert.equal(reconciliationRelayReady(a.report()),false)
})
