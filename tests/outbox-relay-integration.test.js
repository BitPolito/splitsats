import test from 'node:test'
import assert from 'node:assert/strict'
import { RelayPool } from '../src/lib/relay-pool.js'
import { SignedEventOutbox, replayStoredEvents } from '../src/lib/outbox.js'

const pubkey = 'a'.repeat(64)
const signed = { id: '9'.repeat(64), pubkey, sig: 'c'.repeat(128),
  kind: 9000, created_at: 123456, tags: [['g', 'group-1']], content: '{"amount":1000}' }

class Socket {
  readyState = 0
  sent = []
  open() { this.readyState = 1; this.onopen?.() }
  send(raw) { this.sent.push(JSON.parse(raw)) }
  ack(id) { this.onmessage?.({ data: JSON.stringify(['OK', id, true, 'saved']) }) }
  close() { this.readyState = 3; this.onclose?.() }
}

test('after relay timeout + refresh, original signed event is ACKed and cleared', async () => {
  const map = new Map()
  const storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }
  const queue = new SignedEventOutbox({ storage })
  queue.add(signed) // as publishEvent does before publishing

  const firstSocket = new Socket()
  const first = new RelayPool({ socketFactory: () => firstSocket, verifyEvent: () => true, publishTimeoutMs: 10 })
  first.connect('wss://one')
  firstSocket.open()
  await assert.rejects(first.publish(signed), { code: 'RELAY_PUBLICATION_UNKNOWN' })
  first.stop()
  assert.equal(queue.list(pubkey).length, 1)

  const afterRefresh = new SignedEventOutbox({ storage })
  const newSocket = new Socket()
  const nextPool = new RelayPool({ socketFactory: () => newSocket, verifyEvent: () => true, publishTimeoutMs: 1000 })
  nextPool.connect('wss://one')
  newSocket.open()
  const resuming = replayStoredEvents({ pubkey, activePubkey: pubkey, store: afterRefresh,
    verify: () => true, publish: event => nextPool.publish(event) })
  assert.deepEqual(newSocket.sent.find(message => message[0] === 'EVENT')?.[1], signed)
  assert.equal(afterRefresh.list(pubkey).length, 1)
  newSocket.ack(signed.id)
  assert.equal((await resuming)[0].ok, true)
  assert.deepEqual(afterRefresh.list(pubkey), [])
  nextPool.stop()
})
