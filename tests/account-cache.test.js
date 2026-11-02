import test from 'node:test'
import assert from 'node:assert/strict'
import {
  loadGroups, saveGroups, loadProfiles, saveProfiles,
  loadPubkey, savePubkey, clearAll,
} from '../src/lib/storage.js'
import { verifyCachedSigner } from '../src/lib/session-identity.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

function storageFixture() {
  const map = new Map()
  return {
    map,
    getItem(key) { return map.get(key) ?? null },
    setItem(key, value) { map.set(key, value) },
    removeItem(key) { map.delete(key) },
  }
}

function withStorage(fn) {
  const previous = globalThis.localStorage
  const storage = storageFixture()
  globalThis.localStorage = storage
  try { return fn(storage) }
  finally {
    if (previous === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previous
  }
}

test('caches are strictly account scoped even when another pubkey is selected', () => withStorage(() => {
  saveGroups(A, [{ id: 'alice-secret' }])
  saveProfiles(A, { [A]: { name: 'Alice' } })
  saveGroups(B, [{ id: 'bob-secret' }])
  saveProfiles(B, { [B]: { name: 'Bob' } })
  savePubkey(B)
  assert.deepEqual(loadGroups(A), [{ id: 'alice-secret' }])
  assert.deepEqual(loadGroups(B), [{ id: 'bob-secret' }])
  assert.equal(loadProfiles(A)[A].name, 'Alice')
  assert.equal(loadProfiles(B)[B].name, 'Bob')
}))

test('a new signer cannot read old global groups/profiles even if legacy keys remain', () => withStorage(storage => {
  savePubkey(A)
  storage.setItem('splitsats:groups', JSON.stringify([{ id: 'alice-legacy' }]))
  storage.setItem('splitsats:profiles', JSON.stringify({ [A]: { name: 'Alice' } }))
  assert.deepEqual(loadGroups(B), [])
  assert.deepEqual(loadProfiles(B), {})
  assert.ok(storage.getItem('splitsats:groups'))
}))

test('legacy data migrates only for recorded owner; migration is idempotent', () => withStorage(storage => {
  savePubkey(A)
  storage.setItem('splitsats:groups', JSON.stringify([{ id: 'old-group' }]))
  storage.setItem('splitsats:profiles', JSON.stringify({ [A]: { name: 'Original' } }))
  assert.deepEqual(loadGroups(A), [{ id: 'old-group' }])
  assert.equal(loadProfiles(A)[A].name, 'Original')
  assert.equal(storage.getItem('splitsats:groups'), null)
  assert.equal(storage.getItem('splitsats:profiles'), null)
  assert.deepEqual(loadGroups(A), [{ id: 'old-group' }])
  assert.deepEqual(loadGroups(B), [])
}))

test('logout clears only the active account cache and saved pubkey', () => withStorage(() => {
  savePubkey(A)
  saveGroups(A, [{ id: 'a' }])
  saveGroups(B, [{ id: 'b' }])
  clearAll(A)
  assert.equal(loadPubkey(), null)
  assert.deepEqual(loadGroups(A), [])
  assert.deepEqual(loadGroups(B), [{ id: 'b' }])
}))

test('invalid cached account ids do not allow unscoped reads or writes', () => withStorage(storage => {
  storage.setItem('splitsats:pubkey', JSON.stringify('wrong'))
  assert.equal(loadPubkey(), null)
  assert.deepEqual(loadGroups('invalid'), [])
  assert.throws(() => saveGroups('invalid', []), /Cache Nostr non valida/)
  assert.throws(() => savePubkey('invalid'), /Chiave Nostr non valida/)
}))

test('cache storage errors do not expose the previous account', () => withStorage(storage => {
  storage.getItem = () => { throw new Error('Storage inaccessible') }
  assert.deepEqual(loadGroups(A), [])
  assert.deepEqual(loadProfiles(B), {})
  assert.equal(loadPubkey(), null)
}))

test('cached Nostr account is restored only when the active signer agrees', async () => {
  assert.equal(await verifyCachedSigner(A, { getPublicKey: async () => A }), A)
  assert.equal(await verifyCachedSigner(A, { getPublicKey: async () => B }), null)
  assert.equal(await verifyCachedSigner(A, { getPublicKey: async () => { throw new Error('Denied') } }), null)
})

test('cached session refuses invalid IDs, missing signer and malformed signer', async () => {
  assert.equal(await verifyCachedSigner('invalid', { getPublicKey: async () => A }), null)
  assert.equal(await verifyCachedSigner(A, null), null)
  assert.equal(await verifyCachedSigner(A, { getPublicKey: 42 }), null)
})
