import test from 'node:test'
import assert from 'node:assert/strict'
import { SignedEventOutbox, replayStoredEvents } from '../src/lib/outbox.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const SIG = 'c'.repeat(128)
const event = (id = '1'.repeat(64), pubkey = A, kind = 9000, group = 'group-1') => ({
  id, pubkey, sig: SIG, kind, created_at: 1234, content: '{}', tags: [['g', group]],
})

function fixture() {
  const data = new Map()
  const storage = {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => { data.set(key, value) },
  }
  return { store: new SignedEventOutbox({ storage }), storage, data }
}

test('persists exact signed event and survives new instance (refresh)', () => {
  const { store, storage } = fixture()
  const original = event()
  store.add(original)
  const later = new SignedEventOutbox({ storage })
  assert.deepEqual(later.list(A).map(row => row.event), [original])
  assert.equal(later.list(A)[0].event.id, original.id)
})

test('account isolation and idempotent re-addition', () => {
  const { store } = fixture()
  store.add(event())
  store.add(event())
  assert.equal(store.list(A).length, 1)
  assert.equal(store.list(B).length, 0)
})

test('removes exactly the ACKed event', () => {
  const { store } = fixture()
  store.add(event())
  store.add(event('2'.repeat(64), A, 9001))
  assert.equal(store.remove(A, '1'.repeat(64)), true)
  assert.equal(store.remove(A, '1'.repeat(64)), false)
  assert.deepEqual(store.list(A).map(row => row.event.id), ['2'.repeat(64)])
})

test('blocks duplicate new operations in the same kind/group while keeping original', () => {
  const { store } = fixture()
  store.add(event())
  assert.throws(() => store.add(event('2'.repeat(64))), { code: 'OUTBOX_PENDING' })
  assert.equal(store.list(A).length, 1)
  store.add(event('2'.repeat(64), A, 9000, 'other-group'))
  assert.equal(store.list(A).length, 2)
})

test('prevents second group creation while one has uncertain delivery', () => {
  const { store } = fixture()
  store.add(event('1'.repeat(64), A, 30001, 'first-group'))
  assert.throws(() => store.add(event('2'.repeat(64), A, 30001, 'second-group')), { code: 'OUTBOX_PENDING' })
})

test('fails closed when storage write fails, preserving safety', () => {
  const { store } = fixture()
  store._storage.setItem = () => { throw new Error('quota') }
  assert.throws(() => store.add(event()), { code: 'OUTBOX_STORAGE_UNAVAILABLE' })
})

test('corrupted stored queue is never overwritten or silently discarded', () => {
  const { store, data } = fixture()
  data.set('splitsats:outbox:v1:' + A, '{malformed')
  assert.throws(() => store.add(event()), { code: 'OUTBOX_DATA_ERROR' })
  assert.equal(data.get('splitsats:outbox:v1:' + A), '{malformed')
})

test('rejects malformed signatures, malformed IDs and excessively large contents', () => {
  const { store } = fixture()
  assert.throws(() => store.add({ ...event(), sig: 'no' }), { code: 'OUTBOX_INVALID_EVENT' })
  assert.throws(() => store.add({ ...event(), id: 'no' }), { code: 'OUTBOX_INVALID_EVENT' })
  assert.throws(() => store.add({ ...event(), content: 'a'.repeat(34000) }), { code: 'OUTBOX_INVALID_EVENT' })
})

test('replay refuses wrong signer before any network activity', async () => {
  const { store } = fixture()
  store.add(event())
  let sent = 0
  await assert.rejects(replayStoredEvents({ pubkey: A, activePubkey: B, store, verify: () => true, publish: () => { sent++ } }), { code: 'OUTBOX_ACCOUNT_MISMATCH' })
  assert.equal(sent, 0)
  assert.equal(store.list(A).length, 1)
})

test('replay uses original event and removes only after ACK', async () => {
  const { store } = fixture()
  store.add(event())
  const original = store.list(A)[0].event
  let pendingResolve
  const sent = []
  const publishing = replayStoredEvents({ pubkey: A, activePubkey: A, store,
    verify: () => true,
    publish: e => { sent.push(e); return new Promise(resolve => { pendingResolve = resolve }) },
  })
  assert.deepEqual(sent, [original])
  assert.equal(store.list(A).length, 1)
  pendingResolve({ relay: 'wss://one' })
  assert.deepEqual(await publishing, [{ id: original.id, ok: true }])
  assert.deepEqual(store.list(A), [])
})

test('timeout leaves same signed ID queued and retry sends it again', async () => {
  const { store } = fixture()
  store.add(event())
  const failed = await replayStoredEvents({ pubkey: A, activePubkey: A, store, verify: () => true,
    publish: async () => { throw new Error('timeout') } })
  assert.equal(failed[0].ok, false)
  assert.equal(store.list(A).length, 1)
  const successful = await replayStoredEvents({ pubkey: A, activePubkey: A, store, verify: () => true,
    publish: async e => { assert.deepEqual(e, event()) } })
  assert.equal(successful[0].ok, true)
  assert.equal(store.list(A).length, 0)
})

test('invalid signature is never sent and not removed', async () => {
  const { store } = fixture()
  store.add(event())
  let sent = false
  const results = await replayStoredEvents({ pubkey: A, activePubkey: A, store, verify: () => false,
    publish: async () => { sent = true } })
  assert.equal(sent, false)
  assert.equal(results[0].ok, false)
  assert.equal(store.list(A).length, 1)
})

test('outbox notifies observers and unsubscribe works', () => {
  const { store } = fixture()
  let changes = 0
  const unsub = store.subscribe(() => { changes++ })
  store.add(event())
  store.remove(A, event().id)
  assert.equal(changes, 2)
  unsub()
  store.add(event())
  assert.equal(changes, 2)
})

test('a verifier exception skips malformed event without attempting network I/O', async () => {
  const { store } = fixture()
  store.add(event())
  let sent = false
  const results = await replayStoredEvents({ pubkey: A, activePubkey: A, store,
    verify: () => { throw new Error('invalid') }, publish: async () => { sent = true } })
  assert.equal(sent, false)
  assert.equal(results[0].ok, false)
  assert.equal(store.list(A).length, 1)
})
