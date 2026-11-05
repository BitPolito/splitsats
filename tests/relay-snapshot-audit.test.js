import test from 'node:test'
import assert from 'node:assert/strict'
import { RelaySnapshotAudit, MAX_AUDIT_IDS_PER_RELAY } from '../src/lib/relay-snapshot-audit.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64)
const RELAYS = ['wss://one.test', 'wss://two.test', 'wss://three.test']
const ev = (n, rest = {}) => ({ id: n.toString(16).padStart(64, '0'),
  pubkey: A, kind: 9000, created_at: 100, content: '{}', tags: [],
  sig: 'f'.repeat(128), ...rest })
const audit = () => new RelaySnapshotAudit(RELAYS)

test('starts pending; no payment or historical completeness assertion ever appears', () => {
  const result = audit().report()
  assert.equal(result.status, 'pending')
  assert.equal(result.completeHistory, false)
  assert.equal(result.safeForPayments, false)
  assert.equal(result.completedRelays, 0)
})
test('requires EOSE from every configured relay for matching-observed', () => {
  const a = audit()
  for (const relay of RELAYS) a.record(relay, ev(1))
  a.eose(RELAYS[0]); a.eose(RELAYS[1])
  assert.equal(a.report().status, 'pending')
  a.eose(RELAYS[2])
  assert.equal(a.report().status, 'matching-observed')
  assert.equal(a.report().completeHistory, false)
})
test('compares actual signed IDs per relay rather than union of received events', () => {
  const a = audit()
  a.record(RELAYS[0], ev(1)); a.record(RELAYS[1], ev(2))
  a.eose(RELAYS[0]); a.eose(RELAYS[1])
  assert.equal(a.report().status, 'divergent')
  assert.equal(a.report().completedRelays, 2)
  assert.equal(a.report().comparable, true)
})
test('different signed envelopes for the same ID are inconsistent', () => {
  const a = audit()
  a.record(RELAYS[0], ev(1))
  a.record(RELAYS[1], ev(1, { pubkey: B }))
  a.eose(RELAYS[0]); a.eose(RELAYS[1])
  assert.equal(a.report().status, 'divergent')
})
test('same relay duplicate does not affect counts; divergent duplicate flags conflict', () => {
  const a = audit()
  assert.equal(a.record(RELAYS[0], ev(1)), true)
  assert.equal(a.record(RELAYS[0], ev(1)), false)
  assert.equal(a.report().relays[0].eventCount, 1)
  a.record(RELAYS[0], ev(1, { pubkey: B }))
  assert.equal(a.report().status, 'conflict')
})
test('later new event after EOSE invalidates the initial snapshot', () => {
  const a = audit()
  for (const relay of RELAYS) { a.record(relay, ev(1)); a.eose(relay) }
  assert.equal(a.report().status, 'matching-observed')
  a.record(RELAYS[1], ev(2))
  assert.equal(a.report().status, 'changed-after-eose')
  assert.equal(a.report().relays[1].lateEvents, true)
})
test('disconnect invalidates previous matching state; reconnect starts new epoch', () => {
  const a = audit()
  for (const relay of RELAYS) { a.record(relay, ev(1)); a.eose(relay) }
  a.reset(RELAYS[0], 'disconnected')
  assert.equal(a.report().status, 'pending')
  assert.equal(a.report().relays[0].phase, 'offline')
  a.reset(RELAYS[0], 'connected')
  assert.equal(a.report().relays[0].epoch, 2)
  a.record(RELAYS[0], ev(1)); a.eose(RELAYS[0])
  assert.equal(a.report().status, 'matching-observed')
})
test('overflow remains sticky after reconnect and never becomes matching', () => {
  const a = new RelaySnapshotAudit(RELAYS)
  // The protocol cap is fixed and conservative (not caller-expandable).
  for (let i=0;i<MAX_AUDIT_IDS_PER_RELAY+1;i++) a.record(RELAYS[0], ev(i+1))
  assert.equal(a.report().status, 'overflow')
  a.reset(RELAYS[0])
  assert.equal(a.report().status, 'overflow')
})
test('rejects invalid event envelopes and unknown relay; does not trust unknown source', () => {
  const a = audit()
  assert.equal(a.record('wss://untrusted.test', ev(1)), false)
  assert.equal(a.record(RELAYS[0], { ...ev(1), id: 'not-valid' }), false)
  assert.equal(a.report().status, 'conflict')
})
test('relay count and event count never authorize a balance', () => {
  const a = audit()
  for (const relay of RELAYS) { a.record(relay, ev(15)); a.eose(relay) }
  const report = a.report()
  assert.equal(report.safeForPayments, false)
  assert.equal(report.completeHistory, false)
  assert.equal('observedNet' in report, false)
  assert.deepEqual(report.relays.map(r => r.eventCount), [1,1,1])
})
test('exact 500-result query limit is marked potentially truncated, not matching', () => {
  const a = audit()
  for (const relay of RELAYS) {
    for (let i=0;i<MAX_AUDIT_IDS_PER_RELAY;i++) a.record(relay,ev(i+1))
    a.eose(relay)
  }
  assert.equal(a.report().status,'at-limit')
  assert.equal(a.report().safeForPayments,false)
})
