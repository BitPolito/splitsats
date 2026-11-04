import test from 'node:test'
import assert from 'node:assert/strict'
import { canResumeAfterPriorHistory } from '../src/lib/prior-history-gate.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)
const R0 = '0'.repeat(64), R1 = '1'.repeat(64)
const base = () => ({
  _revisionId: R1, _revisionStatus: 'verified',
  _priorHistoryChecked: false, _historicalActivityDetected: false,
  members: [A, C],
  _revisions: [
    { id: R0, members: [A, B, C], consentPolicy: 'signed-invites-v1' },
    { id: R1, members: [A, C], exitedMember: B },
  ],
})

test('a signed exit alone cannot unlock before older-head EOSE', () => {
  assert.equal(canResumeAfterPriorHistory(base(), 'verified'), false)
})
test('EOSE and verified exit proof both required', () => {
  const g = { ...base(), _priorHistoryChecked: true }
  assert.equal(canResumeAfterPriorHistory(g, 'pending'), false)
  assert.equal(canResumeAfterPriorHistory(g, 'conflict'), false)
  assert.equal(canResumeAfterPriorHistory(g, 'verified'), true)
})
test('late older-head financial activity is a permanent local lock', () => {
  const g = { ...base(), _priorHistoryChecked: true, _historicalActivityDetected: true }
  assert.equal(canResumeAfterPriorHistory(g, 'verified'), false)
})
test('legacy removed-member revisions stay locked even after EOSE', () => {
  const g = { ...base(), _priorHistoryChecked: true }
  delete g._revisions[0].consentPolicy
  assert.equal(canResumeAfterPriorHistory(g, 'verified'), false)
})
test('additive revisions also wait for older financial history to load', () => {
  const g = base()
  g._revisions[0].members = [A, B]
  g._revisions[1].members = [A, B, C]
  g.members = [A, B, C]
  delete g._revisions[1].exitedMember
  assert.equal(canResumeAfterPriorHistory(g, 'verified'), false)
  g._priorHistoryChecked = true
  assert.equal(canResumeAfterPriorHistory(g, 'pending'), true)
})
test('stale head, unverified chain, or incomplete data never unlock', () => {
  for (const change of [
    { _revisionId: R0 },
    { _revisionStatus: 'pending' },
    { _revisions: [] },
    { _revisions: [{ id: R0, members: [A, B, C] }, { id: R1 }] },
  ]) {
    assert.equal(canResumeAfterPriorHistory({ ...base(), _priorHistoryChecked: true, ...change }, 'verified'), false)
  }
})
