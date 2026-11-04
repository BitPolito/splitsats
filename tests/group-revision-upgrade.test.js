import test from 'node:test'
import assert from 'node:assert/strict'
import { parseGroupEvent } from '../src/lib/event-validation.js'
import { mergeVerifiedGroup } from '../src/lib/group-state.js'
import { SignedEventOutbox } from '../src/lib/outbox.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64)
const R0 = '0'.repeat(64), R1 = '1'.repeat(64)
const old = {
  id: 'a-trip', pubkey: A, name: 'Trip', members: [A, B],
  eventId: 'd'.repeat(64), _groupCreatedAt: 100,
  _revisionId: R0,
}

test('signed metadata binds revisionEventId to the exact r tag', () => {
  const ts = Math.floor(Date.now() / 1000) - 30
  const group = {
    kind: 30001, id: 'e'.repeat(64), pubkey: A, created_at: ts,
    tags: [['d', old.id], ['r', R0], ['t', 'splitsats'], ['p', A], ['p', B]],
    content: JSON.stringify({ id: old.id, name: old.name,
      members: [A, B], revisionEventId: R0 }),
  }
  assert.equal(parseGroupEvent(group, B)?._revisionId, R0)
  assert.equal(parseGroupEvent({ ...group, tags: group.tags.filter(t => t[0] !== 'r') }, B), null)
  assert.equal(parseGroupEvent({ ...group, tags: [...group.tags, ['r', R1]] }, B), null)
  assert.equal(parseGroupEvent({ ...group, content: JSON.stringify({
    id: old.id, name: old.name, members: [A, B], revisionEventId: R1 }) }, B), null)
})

test('a newer signed head clears all previous financial data until verified', () => {
  const snapshot = mergeVerifiedGroup([], old)
  assert.equal(snapshot[0]._revisionStatus, 'pending')
  const verified = [{ ...snapshot[0], _revisionStatus: 'verified',
    _revisions: [{ id: R0 }],
    expenses: [{ id: 'expense1' }], settlements: [{ id: 'claim1' }],
    confirmations: [{ id: 'confirmation1' }] }]
  const newer = { ...old, _revisionId: R1, eventId: 'f'.repeat(64), _groupCreatedAt: 101 }
  const next = mergeVerifiedGroup(verified, newer)
  assert.equal(next[0]._revisionStatus, 'pending')
  assert.deepEqual(next[0]._revisions, [])
  assert.deepEqual(next[0].expenses, [])
  assert.deepEqual(next[0].settlements, [])
  assert.deepEqual(next[0].confirmations, [])
})


test('unfinished genesis publication blocks duplicate group creation in durable outbox', () => {
  const rows = new Map()
  const store = { getItem: key => rows.get(key) ?? null,
    setItem: (key, value) => rows.set(key, value),
    removeItem: key => rows.delete(key) }
  const outbox = new SignedEventOutbox({ storage: store })
  const genesis = { kind: 9591, id: '3'.repeat(64), pubkey: A, sig: 'a'.repeat(128),
    created_at: 10, tags: [['g', old.id]], content: '{}' }
  const definition = { ...genesis, kind: 30001, id: '4'.repeat(64) }
  outbox.add(genesis)
  assert.equal(outbox.hasConflict(definition), true)
  assert.throws(() => outbox.add(definition), error => error.code === 'OUTBOX_PENDING')
})
