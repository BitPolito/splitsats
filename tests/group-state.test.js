import test from 'node:test'
import assert from 'node:assert/strict'
import { groupAddress } from '../src/lib/group-history.js'
import { findGroupByRef, mergeVerifiedGroup, isLegacyAmbiguous, mayApplyGroupTransaction } from '../src/lib/group-state.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const V = 'c'.repeat(64)
const original = (pubkey, id='shared') => ({ id, pubkey, name: pubkey === A ? 'Group A' : 'Group B',
  members: [pubkey, V], eventId: pubkey, _groupCreatedAt: 100 })

test('two authors with identical d-tags are stored and found independently', () => {
  let groups = mergeVerifiedGroup([], original(A))
  groups = mergeVerifiedGroup(groups, original(B))
  assert.equal(groups.length, 2)
  assert.equal(findGroupByRef(groups, groupAddress(original(A))).name, 'Group A')
  assert.equal(findGroupByRef(groups, groupAddress(original(B))).name, 'Group B')
  assert.equal(findGroupByRef(groups, 'shared'), null)
  assert.equal(isLegacyAmbiguous(groups, groupAddress(original(A))), true)
})

test('when a collision becomes known, unscoped transactions are quarantined, scoped transactions survive', () => {
  const first = original(A)
  const key = groupAddress(first)
  let groups = mergeVerifiedGroup([], first)
  assert.equal(mayApplyGroupTransaction(groups, key, { _legacyUnscoped: true }), true)
  groups[0].expenses = [
    { id: 'old', _legacyUnscoped: true },
    { id: 'scoped', _legacyUnscoped: false },
  ]
  groups[0].settlements = [{ id: 'claim', _legacyUnscoped: true }]
  groups[0].confirmations = [{ id: 'receipt', _legacyUnscoped: true }]
  groups = mergeVerifiedGroup(groups, original(B))
  assert.deepEqual(groups[0].expenses.map(e => e.id), ['scoped'])
  assert.deepEqual(groups[0].settlements, [])
  assert.deepEqual(groups[0].confirmations, [])
  assert.equal(groups[0]._legacyQuarantined, true)
  assert.equal(groups[1]._legacyQuarantined, true)
  assert.equal(mayApplyGroupTransaction(groups, key, { _legacyUnscoped: true }), false)
  assert.equal(mayApplyGroupTransaction(groups, key, { _legacyUnscoped: false }), true)
})

test('a valid newer revision updates exactly its author-scoped group without losing scoped events', () => {
  const a = original(A)
  let groups = mergeVerifiedGroup(mergeVerifiedGroup([], a), original(B))
  groups = groups.map(group => group.pubkey === A
    ? { ...group, expenses: [{ id: 'paid', _legacyUnscoped: false }] } : group)
  groups = mergeVerifiedGroup(groups, { ...a, eventId: 'e'.repeat(64), _groupCreatedAt: 101,
    name: 'Updated A', members: [A, B, V] })
  assert.equal(groups[0].name, 'Updated A')
  assert.equal(groups[1].name, 'Group B')
  assert.deepEqual(groups[0].expenses.map(e => e.id), ['paid'])
  const ignored = mergeVerifiedGroup(groups, { ...a, _groupCreatedAt: 99 })
  assert.equal(ignored, groups)
})

test('unknown or raw d-tag references cannot select a group for financial writes', () => {
  const groups = [original(A)]
  assert.equal(findGroupByRef(groups, 'shared'), null)
  assert.equal(mayApplyGroupTransaction(groups, 'shared', { _legacyUnscoped: false }), false)
  assert.equal(findGroupByRef(groups, `30001:${B}:shared`), null)
})
