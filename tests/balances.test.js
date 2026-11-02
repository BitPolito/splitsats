import test from 'node:test'
import assert from 'node:assert/strict'
import { calcNetBalances, simplifyDebts, memberSummary } from '../src/lib/balances.js'

test('splits evenly when a payment is divisible by participant count', () => {
  assert.deepEqual(calcNetBalances([
    { amount: 120, paidBy: 'alice', splits: ['alice', 'bob', 'carol'] },
  ], [], ['alice', 'bob', 'carol']), { alice: 80, bob: -40, carol: -40 })
})

test('distributes indivisible satoshis deterministically without losing value', () => {
  const members = ['alice', 'bob', 'carol']
  const net = calcNetBalances([
    { amount: 101, paidBy: 'alice', splits: members },
  ], [], members)
  assert.deepEqual(net, { alice: 67, bob: -34, carol: -33 })
  assert.equal(Object.values(net).reduce((sum, n) => sum + n, 0), 0)
})

test('payer outside the split is reimbursed the entire expense', () => {
  assert.deepEqual(calcNetBalances([
    { amount: 5, paidBy: 'alice', splits: ['bob', 'carol'] },
  ], [], ['alice', 'bob', 'carol']), { alice: 5, bob: -3, carol: -2 })
})

test('rejects invalid amounts, participants and duplicated split members', () => {
  const members = ['alice', 'bob']
  const expenses = [
    { amount: -20, paidBy: 'alice', splits: ['alice', 'bob'] },
    { amount: 0, paidBy: 'alice', splits: ['bob'] },
    { amount: 1.5, paidBy: 'alice', splits: ['bob'] },
    { amount: 20, paidBy: 'unknown', splits: ['alice', 'bob'] },
    { amount: 11, paidBy: 'alice', splits: ['bob', 'bob', 'unknown'] },
  ]
  assert.deepEqual(calcNetBalances(expenses, [], members), { alice: 11, bob: -11 })
})

test('applies settlements and simplifies outstanding debts', () => {
  const members = ['alice', 'bob', 'carol']
  const expenses = [{ amount: 90, paidBy: 'alice', splits: members }]
  const settlements = [{ from: 'bob', to: 'alice', amount: 25 }]
  assert.deepEqual(calcNetBalances(expenses, settlements, members), {
    alice: 35, bob: -5, carol: -30,
  })
  assert.deepEqual(simplifyDebts(expenses, settlements, members), [
    { from: 'carol', to: 'alice', amount: 30 },
    { from: 'bob', to: 'alice', amount: 5 },
  ])
  assert.deepEqual(memberSummary('alice', expenses, settlements, members), {
    balance: 35, isCreditor: true, isDebtor: false, isSettled: false,
  })
})

test('ignores invalid settlements', () => {
  assert.deepEqual(calcNetBalances([], [
    { from: 'bob', to: 'alice', amount: 0 },
    { from: 'bob', to: 'alice', amount: -10 },
    { from: 'bob', to: 'unknown', amount: 10 },
    { from: 'bob', to: 'bob', amount: 10 },
    { from: 'bob', to: 'alice', amount: 1.5 },
  ], ['alice', 'bob']), { alice: 0, bob: 0 })
})
