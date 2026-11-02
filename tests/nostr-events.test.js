import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseGroupEvent, parseExpenseEvent, parseSettlementEvent, isNewerGroupDefinition,
} from '../src/lib/event-validation.js'

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)
const MALLORY = 'd'.repeat(64)
const EVENT_ID = 'e'.repeat(64)
const created_at = Math.floor(Date.now() / 1000) - 60
const group = { id: 'group-1', members: [ALICE, BOB, CAROL] }

function event(kind, content, { author = ALICE, tags, id = EVENT_ID, time = created_at } = {}) {
  const defaults = kind === 30001
    ? [['d', 'group-1'], ['t', 'splitsats'], ...group.members.map(pk => ['p', pk])]
    : kind === 9000
      ? [['g', 'group-1'], ['t', 'splitsats'], ...group.members.map(pk => ['p', pk])]
      : [['g', 'group-1'], ['p', ALICE], ['t', 'splitsats']]
  return { id, kind, pubkey: author, created_at: time,
    tags: tags ?? defaults, content: JSON.stringify(content) }
}
const groupData = { id: 'group-1', name: 'Viaggio', members: group.members, createdAt: created_at }
const expenseData = { id: 'expense1', description: 'Dinner', amount: 101, paidBy: ALICE,
  splits: [ALICE, BOB, CAROL], category: 'food', createdAt: created_at }
const settlementData = { id: 'pay1', from: BOB, to: ALICE, amount: 34, settledAt: created_at }

// Groups

test('accepts an invited member only if signed p tags match the member list', () => {
  const parsed = parseGroupEvent(event(30001, groupData), BOB)
  assert.equal(parsed?.pubkey, ALICE)
  assert.equal(parsed?.id, 'group-1')
  assert.equal(parsed?._groupCreatedAt, created_at)
})

test('does not accept an unsolicited group with only a p tag mentioning the viewer', () => {
  const forged = event(30001, { ...groupData, members: [ALICE, CAROL] })
  assert.equal(parseGroupEvent(forged, BOB), null)
})

test('rejects a group whose creator is not a member, or is malformed', () => {
  assert.equal(parseGroupEvent(event(30001, { ...groupData, members: [BOB, CAROL] },
    { tags: [['d','group-1'],['t','splitsats'],['p',BOB],['p',CAROL]] }), BOB), null)
  assert.equal(parseGroupEvent(event(30001, { ...groupData, name: '' }), BOB), null)
  assert.equal(parseGroupEvent(event(30001, { ...groupData, members: [ALICE, BOB, BOB] }), BOB), null)
  assert.equal(parseGroupEvent(event(30001, { ...groupData, id: 'wrong' }), BOB), null)
})

test('accepts explicitly normalized legacy npub content and rejects invalid normalization', () => {
  const data = { ...groupData, members: ['legacy-alice', 'legacy-bob', 'legacy-carol'] }
  const normalizer = x => ({ 'legacy-alice': ALICE, 'legacy-bob': BOB, 'legacy-carol': CAROL })[x] || x
  assert.deepEqual(parseGroupEvent(event(30001, data), BOB, normalizer)?.members, group.members)
  assert.equal(parseGroupEvent(event(30001, data), BOB), null)
})

test('newest group revision wins regardless of relay ordering; cross-author overwrite rejected', () => {
  const old = parseGroupEvent(event(30001, groupData, { time: created_at - 10 }), ALICE)
  const newer = parseGroupEvent(event(30001, { ...groupData, name: 'Nuovo' },
    { time: created_at, id: 'f'.repeat(64) }), ALICE)
  assert.ok(old && newer)
  assert.equal(isNewerGroupDefinition(old, newer), true)
  assert.equal(isNewerGroupDefinition(newer, old), false)
  assert.equal(isNewerGroupDefinition(newer, { ...newer, pubkey: MALLORY }), false)
  assert.equal(isNewerGroupDefinition(newer, newer), false)
  const tiedEarlier = { ...old, _groupCreatedAt: created_at, eventId: 'a'.repeat(64) }
  assert.equal(isNewerGroupDefinition(tiedEarlier, newer), true)
  assert.equal(isNewerGroupDefinition(newer, tiedEarlier), false)
  assert.equal(isNewerGroupDefinition(null, newer), true)
})

test('rejects untagged, duplicate-tagged, future-dated and nonmatching group events', () => {
  const signed = event(30001, groupData)
  assert.equal(parseGroupEvent({ ...signed, tags: signed.tags.filter(t => t[0] !== 't') }, ALICE), null)
  assert.equal(parseGroupEvent({ ...signed, tags: [...signed.tags, ['d', 'group-1']] }, ALICE), null)
  assert.equal(parseGroupEvent({ ...signed, created_at: Math.floor(Date.now() / 1000) + 3600 }, ALICE), null)
  assert.equal(parseGroupEvent({ ...signed, kind: 9000 }, ALICE), null)
})

// Expenses

test('accepts collaborative expense signed by any current member', () => {
  const e = parseExpenseEvent(event(9000, expenseData, { author: BOB }), group)
  assert.equal(e?.amount, 101)
  assert.equal(e?._pubkey, BOB)
  assert.equal(e?._eventId, EVENT_ID)
})

test('rejects expense written by non-member even with a valid signature', () => {
  assert.equal(parseExpenseEvent(event(9000, expenseData, { author: MALLORY }), group), null)
})

test('rejects expense with wrong or duplicate group tags', () => {
  assert.equal(parseExpenseEvent(event(9000, expenseData, { tags: [['g', 'other'], ['t', 'splitsats']] }), group), null)
  assert.equal(parseExpenseEvent(event(9000, expenseData, { tags: [['g', group.id], ['g', 'other'], ['t', 'splitsats']] }), group), null)
})

test('rejects a forged payer, splits outside group, duplicate splits, and invalid amounts', () => {
  assert.equal(parseExpenseEvent(event(9000, { ...expenseData, paidBy: MALLORY }), group), null)
  assert.equal(parseExpenseEvent(event(9000, { ...expenseData, splits: [BOB, MALLORY] }), group), null)
  assert.equal(parseExpenseEvent(event(9000, { ...expenseData, splits: [BOB, BOB] }), group), null)
  assert.equal(parseExpenseEvent(event(9000, { ...expenseData, splits: [] }), group), null)
  assert.equal(parseExpenseEvent(event(9000, { ...expenseData, amount: 0 }), group), null)
  assert.equal(parseExpenseEvent(event(9000, { ...expenseData, amount: 1.5 }), group), null)
  assert.equal(parseExpenseEvent(event(9000, { ...expenseData, amount: '500' }), group), null)
  assert.equal(parseExpenseEvent(event(9000, { ...expenseData, description: ' ' }), group), null)
})

test('rejects malformed JSON, unsafe event envelope and invalid shapes', () => {
  assert.equal(parseExpenseEvent({ ...event(9000, expenseData), content: '{broken' }, group), null)
  assert.equal(parseExpenseEvent({ ...event(9000, expenseData), id: 'bad' }, group), null)
  assert.equal(parseExpenseEvent(event(9000, 'hello'), group), null)
  assert.equal(parseExpenseEvent(event(9000, { ...expenseData, splits: null }), group), null)
})

// Settlements

test('accepts a debtor-signed settlement in the same group', () => {
  const e = event(9001, settlementData, { author: BOB })
  assert.equal(parseSettlementEvent(e, group)?.amount, 34)
  assert.equal(parseSettlementEvent(e, group)?._pubkey, BOB)
})

test('retains compatibility with older settlements without an application ID', () => {
  const { id, ...legacy } = settlementData
  assert.equal(parseSettlementEvent(event(9001, legacy, { author: BOB }), group)?.id, EVENT_ID)
})

test('rejects a member falsely attesting to another debtor’s payment', () => {
  assert.equal(parseSettlementEvent(event(9001, settlementData, { author: CAROL }), group), null)
  assert.equal(parseSettlementEvent(event(9001, settlementData, { author: MALLORY }), group), null)
})

test('rejects settlements with wrong receiver, group tags, member or amount', () => {
  assert.equal(parseSettlementEvent(event(9001, { ...settlementData, to: CAROL }, { author: BOB }), group), null)
  assert.equal(parseSettlementEvent(event(9001, { ...settlementData, from: MALLORY }, { author: MALLORY }), group), null)
  assert.equal(parseSettlementEvent(event(9001, { ...settlementData, from: ALICE, to: ALICE }, { author: ALICE }), group), null)
  assert.equal(parseSettlementEvent(event(9001, { ...settlementData, amount: -1 }, { author: BOB }), group), null)
  assert.equal(parseSettlementEvent(event(9001, { ...settlementData, amount: 1.3 }, { author: BOB }), group), null)
  assert.equal(parseSettlementEvent(event(9001, settlementData, { author: BOB, tags: [['g','wrong'], ['p',ALICE], ['t','splitsats']] }), group), null)
})
