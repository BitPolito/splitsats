import test from 'node:test'
import assert from 'node:assert/strict'
import { KIND_GROUP_REVISION, parseGroupRevisionEvent, revisionTags,
  verifyGroupRevisionHistory, membersForRevisionEvent } from '../src/lib/group-revision-log.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)
const ID0 = '0'.repeat(64), ID1 = '1'.repeat(64), TX = 'f'.repeat(64)
const group = { id: 'trip', pubkey: A, members: [A, B], _revisionId: ID0 }
const timestamp = Math.floor(Date.now() / 1000) - 120
const make = (id, version, previousRevisionId, members = [A, B], owner = A) => ({
  id, kind: KIND_GROUP_REVISION, pubkey: owner, created_at: timestamp + version * 10,
  tags: revisionTags({ ...group, pubkey: owner }, members, previousRevisionId),
  content: JSON.stringify({ groupId: group.id, version, previousRevisionId, members }),
})
const tx = (ref, extras = []) => ({ id: TX, created_at: timestamp + 5, tags: [['r', ref], ...extras] })

test('genesis revision is authenticated by owner, group, tags and signed content', () => {
  const parsed = parseGroupRevisionEvent(make(ID0, 0, null), group)
  assert.deepEqual(parsed, { id: ID0, groupId: 'trip', pubkey: A, version: 0,
    previousRevisionId: null, members: [A, B], createdAt: timestamp })
  assert.equal(parseGroupRevisionEvent({ ...make(ID0, 0, null), pubkey: C }, group), null)
  assert.equal(parseGroupRevisionEvent({ ...make(ID0, 0, null), tags: [['g', 'trip']] }, group), null)
  assert.equal(parseGroupRevisionEvent({ ...make(ID0, 0, null), tags: [...make(ID0, 0, null).tags, ['a', 'bad']] }, group), null)
  assert.equal(parseGroupRevisionEvent({ ...make(ID0, 0, null), content: '{oops' }, group), null)
})

test('complete immutable chain recovers historic members and confirms latest roster', () => {
  const old = parseGroupRevisionEvent(make(ID0, 0, null), group)
  const currentGroup = { ...group, members: [A, C], _revisionId: ID1 }
  const updated = parseGroupRevisionEvent(make(ID1, 1, ID0, [A, C]), group)
  const result = verifyGroupRevisionHistory(currentGroup, [updated, old])
  assert.equal(result.status, 'verified')
  assert.deepEqual(result.chain.map(r => r.id), [ID0, ID1])
  assert.deepEqual(new Set(result.allMembers), new Set([A, B, C]))
  assert.deepEqual(result.removedMembers, [B])
  assert.deepEqual(membersForRevisionEvent(result.chain, tx(ID0)), [A, B])
  assert.deepEqual(membersForRevisionEvent(result.chain, { ...tx(ID1), created_at: timestamp + 12 }), [A, C])
  assert.equal(membersForRevisionEvent(result.chain, { ...tx(ID0), created_at: timestamp + 12 }), null)
})

test('missing ancestors, mismatching head or conflicting versions fail closed', () => {
  const genesis = parseGroupRevisionEvent(make(ID0, 0, null), group)
  const next = parseGroupRevisionEvent(make(ID1, 1, ID0), group)
  const g = { ...group, _revisionId: ID1 }
  assert.equal(verifyGroupRevisionHistory(g, [next]).status, 'pending')
  assert.equal(verifyGroupRevisionHistory({ ...g, members: [A, C] }, [genesis, next]).status, 'conflict')
  assert.equal(verifyGroupRevisionHistory(g, [genesis, next,
    { ...next, id: '2'.repeat(64) }]).status, 'conflict')
})

test('a transaction must bind to exactly one known signed revision', () => {
  const rev = parseGroupRevisionEvent(make(ID0, 0, null), group)
  assert.equal(membersForRevisionEvent([rev], tx('9'.repeat(64))), null)
  assert.equal(membersForRevisionEvent([rev], { ...tx(ID0), tags: [] }), null)
  assert.equal(membersForRevisionEvent([rev], tx(ID0, [['r', ID0]])), null)
  assert.equal(membersForRevisionEvent([rev], { ...tx(ID0), created_at: timestamp - 1 }), null)
  assert.deepEqual(membersForRevisionEvent([rev], tx(ID0)), [A, B])
})
