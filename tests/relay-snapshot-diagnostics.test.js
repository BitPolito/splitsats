import test from 'node:test'
import assert from 'node:assert/strict'
import { RelaySnapshotAudit, MAX_DIAGNOSTIC_SAMPLE } from '../src/lib/relay-snapshot-audit.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64)
const RELAYS = ['wss://one.test', 'wss://two.test', 'wss://three.test']
const envelope = (id, rest = {}) => ({
  id: id.toString(16).padStart(64, '0'), pubkey: A, kind: 9000,
  created_at: 100, content: '{}', tags: [], sig: 'f'.repeat(128), ...rest,
})

test('reports absent observations only for EOSE-completed relay epochs', () => {
  const audit = new RelaySnapshotAudit(RELAYS)
  audit.record(RELAYS[0], envelope(1))
  audit.record(RELAYS[0], envelope(2))
  audit.record(RELAYS[1], envelope(2))
  audit.record(RELAYS[2], envelope(3)) // loading, excluded from the union
  audit.eose(RELAYS[0]); audit.eose(RELAYS[1])
  const result = audit.report()
  assert.equal(result.status, 'divergent')
  assert.equal(result.observedUnionEventCount, 2)
  assert.equal(result.relays[0].notObservedCount, 0)
  assert.equal(result.relays[1].notObservedCount, 1)
  assert.deepEqual(result.relays[1].notObservedSample, [envelope(1).id])
  assert.equal(result.relays[2].notObservedCount, null)
  assert.deepEqual(result.relays[2].notObservedSample, [])
  assert.equal(result.safeForPayments, false)
  assert.equal(result.completeHistory, false)
})

test('one completed relay cannot establish a comparable missing-ID count', () => {
  const audit = new RelaySnapshotAudit(RELAYS)
  audit.record(RELAYS[0], envelope(1))
  audit.eose(RELAYS[0])
  const report = audit.report()
  assert.equal(report.comparable, false)
  assert.equal(report.relays[0].notObservedCount, null)
  assert.equal(report.relays[1].notObservedCount, null)
  assert.equal(report.status, 'pending')
})

test('samples are deterministic, bounded and contain no transaction data', () => {
  const audit = new RelaySnapshotAudit(RELAYS)
  for (let i = 15; i >= 1; i--) audit.record(RELAYS[0], envelope(i))
  audit.eose(RELAYS[0]); audit.eose(RELAYS[1])
  const result = audit.report()
  assert.equal(result.relays[1].notObservedCount, 15)
  assert.deepEqual(result.relays[1].notObservedSample,
    Array.from({ length: MAX_DIAGNOSTIC_SAMPLE }, (_, i) => envelope(i + 1).id))
  assert.equal(result.diagnosticSampleLimit, MAX_DIAGNOSTIC_SAMPLE)
  assert.equal(JSON.stringify(result).includes('observedNet'), false)
  assert.equal(JSON.stringify(result).includes('\"content\"'), false)
})

test('differing envelopes with the same ID do not masquerade as absent IDs', () => {
  const audit = new RelaySnapshotAudit(RELAYS)
  audit.record(RELAYS[0], envelope(1))
  audit.record(RELAYS[1], envelope(1, { pubkey: B }))
  audit.eose(RELAYS[0]); audit.eose(RELAYS[1])
  const result = audit.report()
  assert.equal(result.status, 'divergent')
  assert.equal(result.differingEnvelopeCount, 1)
  assert.deepEqual(result.differingEnvelopeSample, [envelope(1).id])
  assert.equal(result.relays[0].notObservedCount, 0)
  assert.equal(result.relays[1].notObservedCount, 0)
})

test('reconnect invalidates the old epoch comparison, never authorizes payments', () => {
  const audit = new RelaySnapshotAudit(RELAYS.slice(0, 2))
  audit.record(RELAYS[0], envelope(1)); audit.eose(RELAYS[0]); audit.eose(RELAYS[1])
  assert.equal(audit.report().relays[1].notObservedCount, 1)
  audit.reset(RELAYS[1], 'disconnected')
  assert.equal(audit.report().relays[1].notObservedCount, null)
  assert.equal(audit.report().status, 'pending')
  audit.reset(RELAYS[1], 'connected')
  audit.record(RELAYS[1], envelope(1)); audit.eose(RELAYS[1])
  assert.equal(audit.report().status, 'matching-observed')
  assert.equal(audit.report().relays[1].notObservedCount, 0)
  assert.equal(audit.report().safeForPayments, false)
})

test('late observations remain unsafe regardless of their diagnostic counts', () => {
  const audit = new RelaySnapshotAudit(RELAYS.slice(0, 2))
  audit.record(RELAYS[0], envelope(1)); audit.eose(RELAYS[0])
  audit.record(RELAYS[1], envelope(1)); audit.eose(RELAYS[1])
  assert.equal(audit.report().status, 'matching-observed')
  audit.record(RELAYS[0], envelope(2))
  const report = audit.report()
  assert.equal(report.status, 'changed-after-eose')
  assert.equal(report.relays[1].notObservedCount, 1)
  assert.equal(report.safeForPayments, false)
})
