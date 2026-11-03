// Deterministic integration tests: two independent Nostr clients, a shared
// in-memory NIP-01/NIP-20 relay, application parsers, balances and durable outbox.
// Signature verification and Lightning wallets are deliberately simulated;
// this is NOT a live wallet or browser end-to-end test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { RelayPool } from '../src/lib/relay-pool.js'
import { SignedEventOutbox, replayStoredEvents } from '../src/lib/outbox.js'
import { parseGroupEvent, parseExpenseEvent, parseSettlementEvent, parseConfirmationEvent,
  isNewerGroupDefinition } from '../src/lib/event-validation.js'
import { approvedSettlements } from '../src/lib/settlement-status.js'
import { calcNetBalances } from '../src/lib/balances.js'

const ALICE = 'a'.repeat(64)
const BOB = 'b'.repeat(64)
const MALLORY = 'c'.repeat(64)
const GROUP_ID = 'two-client-integration'
let sequence = 0
const signedEvent = (kind, pubkey, content, tags) => ({
  id: (++sequence).toString(16).padStart(64, '0'),
  sig: 'f'.repeat(128),
  pubkey, kind, content: JSON.stringify(content), tags,
  created_at: Math.floor(Date.now() / 1000) - 10,
})
const groupEvent = () => signedEvent(30001, ALICE,
  { id: GROUP_ID, name: 'Weekend', members: [ALICE, BOB] },
  [['t', 'splitsats'], ['d', GROUP_ID], ['p', ALICE], ['p', BOB]])
const expenseEvent = () => signedEvent(9000, ALICE,
  { id: 'expense-1', description: 'Dinner', amount: 600, paidBy: ALICE, splits: [ALICE, BOB] },
  [['t', 'splitsats'], ['g', GROUP_ID], ['p', ALICE], ['p', BOB]])
const claimEvent = () => signedEvent(9001, BOB,
  { id: 'settlement-1', from: BOB, to: ALICE, amount: 300, method: 'webln', walletReported: true },
  [['t', 'splitsats'], ['g', GROUP_ID], ['p', ALICE]])
const confirmationEvent = claim => signedEvent(9002, ALICE,
  { id: 'confirmation-1', settlementEventId: claim.id, from: BOB, to: ALICE, amount: 300 },
  [['t', 'splitsats'], ['g', GROUP_ID], ['p', BOB], ['e', claim.id]])

function matches(event, filter) {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue
    if (!event.tags.some(t => t[0] === key.slice(1) && values.includes(t[1]))) return false
  }
  return true
}

class MemoryRelay {
  constructor() { this.sockets = new Set(); this.events = new Map(); this.ackEnabled = true }
  socket() { const socket = new MemorySocket(this); this.sockets.add(socket); return socket }
  receive(socket, message) {
    const [type, id, ...rest] = message
    if (type === 'REQ') {
      socket.subs.set(id, rest)
      for (const event of this.events.values()) this.deliver(socket, id, rest, event)
      socket.message(['EOSE', id])
    } else if (type === 'CLOSE') {
      socket.subs.delete(id)
    } else if (type === 'EVENT') {
      const event = id
      if (!this.events.has(event.id)) this.events.set(event.id, event)
      for (const peer of this.sockets) {
        for (const [subId, filters] of peer.subs) this.deliver(peer, subId, filters, event)
      }
      if (this.ackEnabled) socket.message(['OK', event.id, true, 'stored'])
    }
  }
  deliver(socket, id, filters, event) {
    if (filters.some(filter => matches(event, filter))) socket.message(['EVENT', id, event])
  }
  duplicate(event) {
    for (const peer of this.sockets) {
      for (const [subId, filters] of peer.subs) this.deliver(peer, subId, filters, event)
    }
  }
}
class MemorySocket {
  constructor(relay) { this.relay = relay; this.readyState = 0; this.subs = new Map() }
  open() { this.readyState = 1; this.onopen?.() }
  send(raw) { this.relay.receive(this, JSON.parse(raw)) }
  message(payload) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(payload) }) }
  close() { this.readyState = 3; this.relay.sockets.delete(this); this.onclose?.() }
}

function startClient(relay, viewer, publishTimeoutMs = 150) {
  const pool = new RelayPool({ socketFactory: () => relay.socket(),
    verifyEvent: event => event.sig === 'f'.repeat(128), publishTimeoutMs, reconnectMaxMs: 5 })
  pool.connect('wss://in-memory.test')
  const socket = [...relay.sockets].at(-1)
  socket.open()
  const data = { group: null, expenses: [], settlements: [], confirmations: [] }
  let stopDetail = []
  const add = (list, parsed) => {
    if (parsed && !list.some(row => row._eventId === parsed._eventId)) list.push(parsed)
  }
  const setGroup = event => {
    const group = parseGroupEvent(event, viewer)
    if (!group || !isNewerGroupDefinition(data.group, group)) return
    data.group = group
    for (const stop of stopDetail) stop()
    stopDetail = [
      pool.subscribe({ id: 'expenses', filters: [{ kinds: [9000], '#g': [group.id] }],
        onEvent: event => add(data.expenses, parseExpenseEvent(event, data.group)) }),
      pool.subscribe({ id: 'settlements', filters: [{ kinds: [9001], '#g': [group.id] }],
        onEvent: event => add(data.settlements, parseSettlementEvent(event, data.group)) }),
      pool.subscribe({ id: 'confirmations', filters: [{ kinds: [9002], '#g': [group.id] }],
        onEvent: event => add(data.confirmations, parseConfirmationEvent(event, data.group)) }),
    ]
  }
  pool.subscribe({ id: 'groups', filters: [{ kinds: [30001], '#p': [viewer] }], onEvent: setGroup })
  const net = () => calcNetBalances(data.expenses,
    approvedSettlements(data.settlements, data.confirmations), [ALICE, BOB])
  return { pool, data, net, stop: () => pool.stop() }
}

function memoryStorage() {
  const map = new Map()
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value) } }
}

test('two accounts independently receive a group and the same expense once across relay replays', async t => {
  const relay = new MemoryRelay()
  const alice = startClient(relay, ALICE)
  const bob = startClient(relay, BOB)
  t.after(() => { alice.stop(); bob.stop() })
  await alice.pool.publish(groupEvent())
  assert.equal(alice.data.group.name, 'Weekend')
  assert.equal(bob.data.group.name, 'Weekend')
  const expense = expenseEvent()
  await alice.pool.publish(expense)
  relay.duplicate(expense)
  assert.equal(alice.data.expenses.length, 1)
  assert.equal(bob.data.expenses.length, 1)
  assert.deepEqual(alice.net(), { [ALICE]: 300, [BOB]: -300 })
  assert.deepEqual(bob.net(), alice.net())
})

test('a wallet-reported transfer does not settle on either client until payee signs', async t => {
  const relay = new MemoryRelay()
  const alice = startClient(relay, ALICE)
  const bob = startClient(relay, BOB)
  t.after(() => { alice.stop(); bob.stop() })
  await alice.pool.publish(groupEvent())
  await alice.pool.publish(expenseEvent())
  const claim = claimEvent()
  await bob.pool.publish(claim)
  assert.deepEqual(alice.net(), { [ALICE]: 300, [BOB]: -300 })
  assert.deepEqual(bob.net(), alice.net())
  // A signed but unauthorized claim by an outsider must not alter either balance.
  const forged = signedEvent(9002, MALLORY,
    { settlementEventId: claim.id, from: BOB, to: ALICE, amount: 300 },
    [['t', 'splitsats'], ['g', GROUP_ID], ['p', BOB], ['e', claim.id]])
  await bob.pool.publish(forged)
  assert.equal(alice.data.confirmations.length, 0)
  assert.equal(bob.data.confirmations.length, 0)
  const confirmation = confirmationEvent(claim)
  await alice.pool.publish(confirmation)
  relay.duplicate(confirmation)
  assert.deepEqual(alice.net(), { [ALICE]: 0, [BOB]: 0 })
  assert.deepEqual(bob.net(), alice.net())
  assert.equal(alice.data.confirmations.length, 1)
  assert.equal(bob.data.confirmations.length, 1)
})

test('uncertain delivery + refresh replays identical event; other client sees no duplicate debt', async t => {
  const relay = new MemoryRelay()
  const alice = startClient(relay, ALICE, 15)
  const bob = startClient(relay, BOB)
  t.after(() => { alice.stop(); bob.stop() })
  await alice.pool.publish(groupEvent())
  const event = expenseEvent()
  const storage = memoryStorage()
  const outbox = new SignedEventOutbox({ storage })
  outbox.add(event)
  relay.ackEnabled = false
  await assert.rejects(alice.pool.publish(event), { code: 'RELAY_PUBLICATION_UNKNOWN' })
  assert.equal(bob.data.expenses.length, 1)
  assert.equal(outbox.list(ALICE).length, 1)
  alice.stop() // browser closes
  relay.ackEnabled = true
  const fresh = startClient(relay, ALICE)
  t.after(() => fresh.stop())
  const results = await replayStoredEvents({ pubkey: ALICE, activePubkey: ALICE, store: outbox,
    verify: event => event.sig === 'f'.repeat(128), publish: event => fresh.pool.publish(event) })
  assert.deepEqual(results.map(row => row.ok), [true])
  assert.equal(outbox.list(ALICE).length, 0)
  assert.equal(relay.events.has(event.id), true)
  assert.equal(relay.events.size, 2) // group and expense, not a second expense
  assert.equal(bob.data.expenses.length, 1)
  assert.deepEqual(bob.net(), { [ALICE]: 300, [BOB]: -300 })
})

test('a new client reconstructs confirmed balances from relay history after reopening', async t => {
  const relay = new MemoryRelay()
  const alice = startClient(relay, ALICE)
  const bob = startClient(relay, BOB)
  t.after(() => { alice.stop(); bob.stop() })
  await alice.pool.publish(groupEvent())
  await alice.pool.publish(expenseEvent())
  const claim = claimEvent()
  await bob.pool.publish(claim)
  await alice.pool.publish(confirmationEvent(claim))
  const reopenedBob = startClient(relay, BOB)
  t.after(() => reopenedBob.stop())
  assert.equal(reopenedBob.data.group.name, 'Weekend')
  assert.equal(reopenedBob.data.expenses.length, 1)
  assert.equal(reopenedBob.data.settlements.length, 1)
  assert.equal(reopenedBob.data.confirmations.length, 1)
  assert.deepEqual(reopenedBob.net(), { [ALICE]: 0, [BOB]: 0 })
})
