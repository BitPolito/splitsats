import test from 'node:test'
import assert from 'node:assert/strict'
import { KIND_GROUP_REVISION, parseGroupRevisionEvent, revisionTags,
  verifyGroupRevisionHistory } from '../src/lib/group-revision-log.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const R0 = '0'.repeat(64)
const R1 = '1'.repeat(64)
const PROOF = '2'.repeat(64)
const started = Math.floor(Date.now() / 1000) - 100
const reference = { id: 'legacy-revision', pubkey: A }

function revision(id, version, previousRevisionId, members, extra = {}) {
  return {
    id, kind: KIND_GROUP_REVISION, pubkey: A, created_at: started + version * 20,
    tags: [...revisionTags(reference, members, previousRevisionId),
      ...(extra.exitProofEventId ? [['x', extra.exitProofEventId]] : [])],
    content: JSON.stringify({ groupId: reference.id, version,
      previousRevisionId, members, ...extra }),
  }
}
const parse = event => parseGroupRevisionEvent(event, reference)
const current = { ...reference, members: [A, C], _revisionId: R1 }

test('legacy chain remains reconstructible but retains removed-member review requirement', () => {
  const genesis = parse(revision(R0, 0, null, [A, B]))
  const oldRemoval = parse(revision(R1, 1, R0, [A, C]))
  const result = verifyGroupRevisionHistory(current, [oldRemoval, genesis])
  assert.equal(result.status, 'verified')
  assert.deepEqual(result.removedMembers, [B])
  assert.deepEqual(result.allMembers.sort(), [A, B, C].sort())
  // The application uses removedMembers.length > 0 to freeze balances.
  assert.equal(result.removedMembers.length > 0, true)
})

test('new opt-in chains reject unsigned removal and mixed add/remove', () => {
  const genesis = parse(revision(R0, 0, null, [A, B, C],
    { consentPolicy: 'signed-invites-v1', expensePolicy: 'unanimous-expense-v1' }))
  const removal = parse(revision(R1, 1, R0, [A, C]))
  assert.equal(verifyGroupRevisionHistory(current, [genesis, removal]).status, 'conflict')
  const mixed = parse(revision(R1, 1, R0, [A, C, 'd'.repeat(64)],
    { exitedMember: B, exitProofEventId: PROOF }))
  assert.equal(verifyGroupRevisionHistory({ ...current, members: [A, C, 'd'.repeat(64)] },
    [genesis, mixed]).status, 'conflict')
})

test('new opt-in chains accept owner-signed exit references for separate proof validation', () => {
  const genesis = parse(revision(R0, 0, null, [A, B, C],
    { consentPolicy: 'signed-invites-v1', expensePolicy: 'unanimous-expense-v1' }))
  const event = revision(R1, 1, R0, [A, C],
    { exitedMember: B, exitProofEventId: PROOF })
  const updated = parse(event)
  assert.ok(updated)
  const result = verifyGroupRevisionHistory(current, [updated, genesis])
  assert.equal(result.status, 'verified')
  assert.deepEqual(result.removedMembers, [B])
  assert.equal(updated.exitProofEventId, PROOF)
  // A revision alone isn't proof of consent: member-exits.js separately
  // verifies that the referenced request was signed by the exiting member.
  assert.equal(parse({ ...event, tags: event.tags.filter(t => t[0] !== 'x') }), null)
})
