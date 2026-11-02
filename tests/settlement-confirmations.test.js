import test from 'node:test'
import assert from 'node:assert/strict'
import { parseConfirmationEvent, parseSettlementEvent } from '../src/lib/event-validation.js'
import { approvedSettlements, settlementStatus, isConfirmedSettlement } from '../src/lib/settlement-status.js'
import { calcNetBalances, simplifyDebts } from '../src/lib/balances.js'

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const CAROL = 'c'.repeat(64)
const MALLORY = 'd'.repeat(64)
const PAYMENT_EVENT = 'e'.repeat(64)
const APPROVAL_EVENT = 'f'.repeat(64)
const now = Math.floor(Date.now() / 1000) - 20
const group = { id: 'trip', members: [ALICE, BOB, CAROL] }
const claim = {
  id: 'claim-1', from: BOB, to: ALICE, amount: 250,
  method: 'webln', walletReported: true, settledAt: now,
}
const acknowledgment = {
  id: 'ack-1', settlementEventId: PAYMENT_EVENT, from: BOB, to: ALICE,
  amount: 250, confirmedAt: now,
}
function event(kind, author, content, tags, id) {
  return { kind, id, pubkey: author, created_at: now, content: JSON.stringify(content), tags }
}
const paymentEvent = (data = claim, author = BOB) => event(9001, author, data,
  [['g', group.id], ['p', ALICE], ['t', 'splitsats']], PAYMENT_EVENT)
const confirmationEvent = (data = acknowledgment, author = ALICE, tags = [
  ['g', group.id], ['e', PAYMENT_EVENT], ['p', BOB], ['t', 'splitsats'],
]) => event(9002, author, data, tags, APPROVAL_EVENT)

test('debtor claim, including WebLN-reported success, never reduces balances before recipient approval', () => {
  const payment = parseSettlementEvent(paymentEvent(), group)
  assert.equal(payment.method, 'webln')
  assert.equal(payment.walletReported, true)
  assert.equal(settlementStatus(payment), 'wallet-reported')
  assert.deepEqual(approvedSettlements([payment], []), [])
  const expenses = [{ paidBy: ALICE, amount: 600, splits: [ALICE, BOB] }]
  assert.deepEqual(calcNetBalances(expenses, approvedSettlements([payment], []), group.members), {
    [ALICE]: 300, [BOB]: -300, [CAROL]: 0,
  })
})

test('recipient signed acknowledgment unlocks the exact settlement exactly once', () => {
  const payment = parseSettlementEvent(paymentEvent(), group)
  const ack = parseConfirmationEvent(confirmationEvent(), group)
  assert.equal(ack._pubkey, ALICE)
  assert.equal(ack.settlementEventId, payment._eventId)
  assert.equal(isConfirmedSettlement(payment, [ack]), true)
  assert.equal(settlementStatus(payment, [ack]), 'confirmed')
  assert.equal(approvedSettlements([payment], [ack, ack]).length, 1)
  assert.deepEqual(simplifyDebts([{ paidBy: ALICE, amount: 600, splits: [ALICE, BOB] }],
    approvedSettlements([payment], [ack]), group.members), [{ from: BOB, to: ALICE, amount: 50 }])
})

test('confirmation before payment still unlocks it after the settlement arrives', () => {
  const ack = parseConfirmationEvent(confirmationEvent(), group)
  assert.deepEqual(approvedSettlements([], [ack]), [])
  const payment = parseSettlementEvent(paymentEvent(), group)
  assert.deepEqual(approvedSettlements([payment], [ack]), [payment])
})

test('no unrelated approval can authorize another amount, sender, receiver or event id', () => {
  const payment = parseSettlementEvent(paymentEvent(), group)
  const confirmation = parseConfirmationEvent(confirmationEvent(), group)
  for (const change of [
    { settlementEventId: '1'.repeat(64) },
    { amount: 249 },
    { from: CAROL },
    { to: CAROL, _pubkey: CAROL },
    { _pubkey: MALLORY },
  ]) {
    assert.equal(isConfirmedSettlement(payment, [{ ...confirmation, ...change }]), false)
  }
})

test('a third party or the debtor cannot approve their own claim', () => {
  assert.equal(parseConfirmationEvent(confirmationEvent(acknowledgment, BOB), group), null)
  assert.equal(parseConfirmationEvent(confirmationEvent(acknowledgment, MALLORY), group), null)
  const otherRecipient = parseConfirmationEvent(confirmationEvent({ ...acknowledgment, to: CAROL }, CAROL), group)
  assert.equal(isConfirmedSettlement(parseSettlementEvent(paymentEvent(), group), [otherRecipient]), false)
})

test('confirmation must reference exact claim hash in signed e tag and exact debtor p tag', () => {
  assert.equal(parseConfirmationEvent(confirmationEvent(acknowledgment, ALICE,
    [['g', group.id], ['e', '1'.repeat(64)], ['p', BOB], ['t','splitsats']]), group), null)
  assert.equal(parseConfirmationEvent(confirmationEvent(acknowledgment, ALICE,
    [['g', group.id], ['e', PAYMENT_EVENT], ['p', CAROL], ['t','splitsats']]), group), null)
  assert.equal(parseConfirmationEvent(confirmationEvent(acknowledgment, ALICE,
    [['g', group.id], ['e', PAYMENT_EVENT], ['e', PAYMENT_EVENT], ['p', BOB], ['t','splitsats']]), group), null)
  assert.equal(parseConfirmationEvent(confirmationEvent(acknowledgment, ALICE,
    [['g', 'wrong'], ['e', PAYMENT_EVENT], ['p', BOB], ['t','splitsats']]), group), null)
})

test('confirmation rejects invalid amounts, IDs, future timestamps and malformed JSON', () => {
  for (const replacement of [
    { amount: -2 }, { amount: 0 }, { amount: '250' }, { settlementEventId: 'invalid' },
    { from: MALLORY }, { id: ' ' },
  ]) {
    assert.equal(parseConfirmationEvent(confirmationEvent({ ...acknowledgment, ...replacement }), group), null)
  }
  assert.equal(parseConfirmationEvent({ ...confirmationEvent(), content: 'not-json' }, group), null)
  assert.equal(parseConfirmationEvent({ ...confirmationEvent(), created_at: now + 3600 }, group), null)
})

test('legacy and manual settlement events remain pending, not silently confirmed', () => {
  const legacy = { from: BOB, to: ALICE, amount: 250, settledAt: now }
  const p = parseSettlementEvent(paymentEvent(legacy), group)
  assert.equal(p.method, 'legacy')
  assert.equal(settlementStatus(p), 'pending')
  assert.deepEqual(approvedSettlements([p], []), [])
  const manual = parseSettlementEvent(paymentEvent({ ...claim, method: 'manual', walletReported: false }), group)
  assert.equal(settlementStatus(manual), 'pending')
})

test('rejects unsupported settlement methods and dishonest walletReported combinations', () => {
  assert.equal(parseSettlementEvent(paymentEvent({ ...claim, method: 'invented' }), group), null)
  const p = parseSettlementEvent(paymentEvent({ ...claim, method: 'manual', walletReported: true }), group)
  assert.equal(p.walletReported, false)
  assert.equal(settlementStatus(p), 'pending')
})

test('development WebLN mock cannot report a real payment', async () => {
  const { payLightningAddress } = await import('../src/lib/lightning.js')
  const previousWindow = globalThis.window
  let called = false
  globalThis.window = { webln: {
    __splitsatsMock: true,
    enable: async () => { called = true },
    sendPayment: async () => { throw new Error('Never call mocked sendPayment') },
  } }
  try {
    await assert.rejects(payLightningAddress('example@bitcoin.com', 1000), /Wallet simulato/)
    assert.equal(called, true)
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})
