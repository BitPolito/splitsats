import test from 'node:test'
import assert from 'node:assert/strict'
import { priorFinancialEvidence, appendPriorEvidence, priorEvidenceCounts,
  MAX_PRIOR_EVIDENCE } from '../src/lib/prior-financial-evidence.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)
const R0 = '0'.repeat(64), R1 = '1'.repeat(64), EVENT = 'f'.repeat(64)
const group = { id: 'trip', pubkey: A, _revisionId: R1, members: [A,C],
  _revisions: [{ id: R0, createdAt: 100, members: [A,B] },
    { id: R1, createdAt: 200, members: [A,C] }] }
const event = (other={}) => ({ id: EVENT, pubkey: B, kind: 9000, created_at: 150,
  tags: [['a', `30001:${A}:trip`], ['g', 'trip'], ['r', R0], ['t', 'splitsats']], ...other })

test('indexes a signature-verified old-head financial event without importing its amount', () => {
  const data = priorFinancialEvidence(group, event({ content: '{"amount":900000}' }))
  assert.deepEqual(data, { eventId: EVENT, revisionId: R0, kind: 9000, author: B, signedAt: 150 })
  assert.equal(data.amount, undefined)
})
test('rejects other author-scoped groups, other heads and current-head events', () => {
  for (const tags of [
    [['a', `30001:${C}:trip`], ['g','trip'], ['r',R0], ['t','splitsats']],
    [['a', `30001:${A}:trip`], ['g','trip'], ['r',R1], ['t','splitsats']],
    [['a', `30001:${A}:trip`], ['g','trip'], ['r','3'.repeat(64)], ['t','splitsats']],
    [['a', `30001:${A}:trip`], ['a', `30001:${A}:trip`], ['g','trip'], ['r',R0], ['t','splitsats']],
  ]) assert.equal(priorFinancialEvidence(group, event({ tags })), null)
})
test('rejects non-members, future-dated historical events and malformed IDs', () => {
  assert.equal(priorFinancialEvidence(group, event({pubkey:C})), null)
  assert.equal(priorFinancialEvidence(group, event({created_at:201})), null)
  assert.equal(priorFinancialEvidence(group, event({created_at:99})), null)
  assert.equal(priorFinancialEvidence(group, event({id:'bad'})), null)
})
test('indexes all five historical financial kinds and counts them separately', () => {
  let entries = []
  for (const kind of [9000,9001,9002,9593,9594]) {
    const proof = priorFinancialEvidence(group, event({kind,id:String(kind).padStart(64,'0')}))
    assert.ok(proof)
    entries = appendPriorEvidence(entries,proof).rows
  }
  assert.deepEqual(priorEvidenceCounts(entries),
    { expenses:1, settlements:1, confirmations:1, decisions:1, cancellations:1 })
})
test('same immutable signed event deduplicates without dropping stored proof', () => {
  const proof = priorFinancialEvidence(group, event())
  const first = appendPriorEvidence([], proof)
  const second = appendPriorEvidence(first.rows, proof)
  assert.equal(first.added, true)
  assert.equal(second.added, false)
  assert.strictEqual(second.rows, first.rows)
})
test('overflow cannot appear as an empty or complete history', () => {
  const rows = Array.from({length:MAX_PRIOR_EVIDENCE},(_,i)=>({eventId:i.toString(16).padStart(64,'0')}))
  const next = appendPriorEvidence(rows, {eventId:EVENT})
  assert.equal(next.overflow, true)
  assert.equal(next.added,false)
  assert.equal(next.rows.length,MAX_PRIOR_EVIDENCE)
  assert.equal(appendPriorEvidence(undefined, {eventId:EVENT}).overflow,true)
})
