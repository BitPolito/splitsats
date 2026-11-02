import test from 'node:test'
import assert from 'node:assert/strict'
import { RelayPool } from '../src/lib/relay-pool.js'

const event = (id = 'a'.repeat(64)) => ({ id, kind: 9000, content: 'test' })

class FakeSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  receive(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
  send(raw) { this.sent.push(JSON.parse(raw)) }
  close() { this.readyState = 3; this.onclose?.() }
}

function harness(timeout = 1000) {
  const created = []
  const pool = new RelayPool({
    socketFactory: url => {
      const s = new FakeSocket(url)
      created.push(s)
      return s
    },
    verifyEvent: e => e.id !== 'invalid',
    publishTimeoutMs: timeout,
    reconnectMaxMs: 1,
  })
  return { pool, created, connect: url => { pool.connect(url); const socket = created.at(-1); socket.open(); return socket } }
}

const sent = (ws, type) => ws.sent.filter(m => m[0] === type)

test('does not resolve just because the event was sent', async () => {
  const { pool, connect } = harness()
  const ws = connect('wss://one')
  let resolved = false
  const pending = pool.publish(event()).then(() => { resolved = true })
  assert.equal(sent(ws, 'EVENT').length, 1)
  await Promise.resolve()
  assert.equal(resolved, false)
  ws.receive(['OK', 'a'.repeat(64), true, 'saved'])
  await pending
  assert.equal(resolved, true)
  pool.stop()
})

test('success at one relay suffices, even if another rejects', async () => {
  const { pool, connect } = harness()
  const one = connect('wss://one')
  const two = connect('wss://two')
  const pending = pool.publish(event())
  one.receive(['OK', event().id, false, 'rate limited'])
  two.receive(['OK', event().id, true, 'accepted'])
  assert.deepEqual(await pending, { relay: 'wss://two' })
  assert.equal(pool._pending.size, 0)
  pool.stop()
})

test('rejects when all known relays explicitly reject', async () => {
  const { pool, connect } = harness()
  const one = connect('wss://one')
  const two = connect('wss://two')
  const pending = pool.publish(event())
  one.receive(['OK', event().id, false, 'blocked'])
  two.receive(['OK', event().id, false, 'blocked'])
  await assert.rejects(pending, /Tutti i relay/)
  pool.stop()
})

test('rejects on timeout with explicit uncertain delivery message', async () => {
  const { pool, connect } = harness(12)
  connect('wss://one')
  await assert.rejects(pool.publish(event()), error => {
    assert.match(error.message, /Esito incerto/)
    assert.equal(error.code, 'RELAY_PUBLICATION_UNKNOWN')
    return true
  })
  assert.equal(pool._pending.size, 0)
  pool.stop()
})

test('queues pending signed event while offline and sends it on connection', async () => {
  const { pool, created } = harness()
  pool.connect('wss://offline')
  const promise = pool.publish(event())
  assert.equal(created[0].sent.length, 0)
  created[0].open()
  assert.equal(sent(created[0], 'EVENT').length, 1)
  created[0].receive(['OK', event().id, true, ''])
  await promise
  pool.stop()
})

test('after reconnect, resends identical signed event ID exactly once on new socket', async () => {
  const { pool, connect, created } = harness()
  const one = connect('wss://one')
  const pending = pool.publish(event())
  one.close()
  await new Promise(r => setTimeout(r, 8))
  assert.equal(created.length, 2)
  const replacement = created[1]
  replacement.open()
  assert.deepEqual(sent(replacement, 'EVENT')[0][1], event())
  replacement.receive(['OK', event().id, true, ''])
  await pending
  pool.stop()
})

test('same event publish while in flight shares promise rather than re-sending', async () => {
  const { pool, connect } = harness()
  const one = connect('wss://one')
  const first = pool.publish(event())
  const second = pool.publish(event())
  assert.equal(first, second)
  assert.equal(sent(one, 'EVENT').length, 1)
  one.receive(['OK', event().id, true, ''])
  await Promise.all([first, second])
  pool.stop()
})

test('ignores unrelated and malformed OK and timeout remains active', async () => {
  const { pool, connect } = harness(12)
  const one = connect('wss://one')
  const promise = pool.publish(event())
  one.receive(['OK', 'b'.repeat(64), true, ''])
  one.receive(['OK', event().id, 'true', ''])
  one.receive('not an array')
  await assert.rejects(promise, /Esito incerto/)
  pool.stop()
})

test('only one initial EOSE callback, without waiting for offline relay', () => {
  const { pool, connect, created } = harness()
  const first = connect('wss://one')
  pool.connect('wss://offline') // CONNECTING, no EOSE ever
  let completed = 0
  pool.subscribe({ id: 'groups', filters: [{ kinds: [30001] }], onEvent: () => {}, onEose: () => { completed++ } })
  first.receive(['EOSE', 'groups'])
  first.receive(['EOSE', 'groups'])
  assert.equal(completed, 1)
  assert.equal(created[1].sent.length, 0)
  pool.stop()
})

test('subscriptions reconnect and closed subscriptions are not replayed', async () => {
  const { pool, connect, created } = harness()
  const first = connect('wss://one')
  const unsub = pool.subscribe({ id: 'profile', filters: [{ kinds: [0] }], onEvent: () => {} })
  assert.equal(sent(first, 'REQ').length, 1)
  first.close()
  unsub()
  await new Promise(r => setTimeout(r, 8))
  created[1].open()
  assert.equal(sent(created[1], 'REQ').length, 0)
  pool.stop()
})

test('valid events deduplicate per subscription, and can replay after re-subscribe', () => {
  const { pool, connect } = harness()
  const ws = connect('wss://one')
  let received = 0
  const sub = { id: 'profile', filters: [{ kinds: [0] }], onEvent: () => { received++ } }
  const unsub = pool.subscribe(sub)
  ws.receive(['EVENT', 'profile', event()])
  ws.receive(['EVENT', 'profile', event()])
  assert.equal(received, 1)
  unsub()
  pool.subscribe(sub)
  ws.receive(['EVENT', 'profile', event()])
  assert.equal(received, 2)
  pool.stop()
})

test('stop rejects pending publications and clears reconnect timers', async () => {
  const { pool, connect } = harness()
  const one = connect('wss://one')
  const pending = pool.publish(event())
  one.close()
  pool.stop()
  await assert.rejects(pending, /terminata/)
  assert.equal(pool._pending.size, 0)
  assert.equal(Object.keys(pool._reconnectTimers).length, 0)
})
