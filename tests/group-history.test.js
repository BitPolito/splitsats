import test from 'node:test'
import assert from 'node:assert/strict'
import {
  groupAddress, matchesGroupAddressTag, resolveGroupAtEvent, revisionAt,
  cleanVerifiedGroupSnapshot,
} from '../src/lib/group-history.js'
import { parseExpenseEvent, parseSettlementEvent, parseConfirmationEvent } from '../src/lib/event-validation.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const D = 'd'.repeat(64)
const time = Math.floor(Date.now() / 1000) - 150
const rev = (owner, id, members, at, eventId = '1'.repeat(64)) =>
  ({ pubkey: owner, id, members, _groupCreatedAt: at, eventId, name: 'Travel' })
const alpha = rev(A, 'same-d', [A, B], time)
const beta = rev(C, 'same-d', [C, D], time)
const expense = (from, tags, at = time + 10) => ({
  kind: 9000, id: 'e'.repeat(64), pubkey: from, created_at: at, tags,
  content: JSON.stringify({ id: 'food', description: 'Lunch', amount: 200, paidBy: from, splits: [from] }),
})
const baseTags = id => [['g', id], ['t', 'splitsats']]

// This phase supplies the pure layer; state/relay subscriptions remain legacy
// until the separately reviewed wiring migration. Tests use parsed fixtures.
test('same d-tag from two authors resolves to two different coordinates', () => {
  assert.notEqual(groupAddress(alpha), groupAddress(beta))
  assert.equal(groupAddress({ ...alpha, pubkey: 'invalid' }), null)
  assert.equal(resolveGroupAtEvent([alpha, beta], expense(A, [...baseTags('same-d'), ['a', groupAddress(alpha)]]))?.address, groupAddress(alpha))
  assert.equal(resolveGroupAtEvent([alpha, beta], expense(C, [...baseTags('same-d'), ['a', groupAddress(beta)]]))?.address, groupAddress(beta))
})

test('legacy unscoped transaction is quarantined when group identifiers collide', () => {
  assert.equal(resolveGroupAtEvent([alpha, beta], expense(A, baseTags('same-d'))), null)
  assert.equal(resolveGroupAtEvent([alpha], expense(A, baseTags('same-d')))?.legacy, true)
  assert.equal(resolveGroupAtEvent([alpha, beta], expense(A, [...baseTags('same-d'), ['a', '30001:' + D + ':same-d']])), null)
  assert.equal(resolveGroupAtEvent([alpha], expense(A, [...baseTags('same-d'), ['a', groupAddress(alpha)], ['a', groupAddress(alpha)]])), null)
})

test('membership changes authorize signed events against earlier valid revision', () => {
  const original = rev(A, 'member-change', [A, B], time)
  const updated = rev(A, 'member-change', [A, C], time + 50, '2'.repeat(64))
  const old = resolveGroupAtEvent([updated, original], expense(B, [...baseTags('member-change'), ['a', groupAddress(original)]], time + 10))
  assert.deepEqual(old?.members, [A, B])
  const current = resolveGroupAtEvent([updated, original], expense(C, [...baseTags('member-change'), ['a', groupAddress(original)]], time + 60))
  assert.deepEqual(current?.members, [A, C])
  assert.equal(old?.members.includes(C), false)
  assert.equal(current?.members.includes(B), false)
  assert.equal(revisionAt([updated, original], time - 1), null)
})

test('conflicting same-second membership changes fail closed', () => {
  const revised = rev(A, 'member-change', [A, C], time, '2'.repeat(64))
  const original = rev(A, 'member-change', [A, B], time)
  assert.equal(revisionAt([revised, original], time + 1), null)
  assert.equal(revisionAt([{ ...original, members: [A, B, B] }], time + 1), null)
  assert.equal(revisionAt([original, beta], time + 1), null)
})

test('a-tag ownership binding is enforced by all three event parsers', () => {
  const group = { id: alpha.id, pubkey: alpha.pubkey, members: alpha.members }
  const mismatch = [...baseTags(group.id), ['a', groupAddress(beta)]]
  const good = [...baseTags(group.id), ['a', groupAddress(alpha)]]
  const eContent = { id: 'exp', description: 'Lunch', amount: 100, paidBy: A, splits: [A, B] }
  const mk = (kind, body, tags, signer) => ({ kind, tags, pubkey: signer, id: 'f'.repeat(64), created_at: time + 10, content: JSON.stringify(body) })
  assert.equal(parseExpenseEvent(mk(9000, eContent, mismatch, A), group), null)
  assert.equal(parseExpenseEvent(mk(9000, eContent, good, A), group)?.amount, 100)
  const claim = { from: B, to: A, amount: 50, id: 'pay' }
  assert.equal(parseSettlementEvent(mk(9001, claim, [...mismatch, ['p', A]], B), group), null)
  assert.equal(parseSettlementEvent(mk(9001, claim, [...good, ['p', A]], B), group)?.amount, 50)
  const confirm = { settlementEventId: 'e'.repeat(64), from: B, to: A, amount: 50 }
  assert.equal(parseConfirmationEvent(mk(9002, confirm, [...mismatch, ['e', confirm.settlementEventId], ['p', B]], A), group), null)
  assert.equal(parseConfirmationEvent(mk(9002, confirm, [...good, ['e', confirm.settlementEventId], ['p', B]], A), group)?.amount, 50)
})

test('duplicate or malformed group address tags cannot fall back to legacy', () => {
  const ev = expense(A, [...baseTags('same-d'), ['a', groupAddress(alpha)]])
  assert.equal(matchesGroupAddressTag(ev, alpha), true)
  assert.equal(matchesGroupAddressTag(ev, beta), false)
  assert.equal(matchesGroupAddressTag({ ...ev, tags: [...ev.tags, ['a', groupAddress(alpha)]] }, alpha), false)
  assert.equal(matchesGroupAddressTag({ ...ev, tags: [...ev.tags, ['a']] }, alpha), false)
})

test('cache rebuilding discards unverified expenses and claims', () => {
  const dirty = { ...alpha, expenses: [{ amount: 999999, paidBy: B }], settlements: [{ amount: 999999 }], confirmations: [{ from: A }] }
  const clean = cleanVerifiedGroupSnapshot(dirty)
  assert.deepEqual(clean?.expenses, [])
  assert.deepEqual(clean?.settlements, [])
  assert.deepEqual(clean?.confirmations, [])
  assert.equal(clean?._synced, false)
  assert.equal(cleanVerifiedGroupSnapshot({ ...dirty, eventId: 'bad' }), null)
})
