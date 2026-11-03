import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getPaymentAttempt, beginPaymentAttempt, updatePaymentAttempt,
  releaseConfirmedPaymentAttempt, releaseVerifiedUnpaidAttempt,
} from '../src/lib/payment-attempts.js'
import { payLightningAddress, prepareExternalWalletInvoice } from '../src/lib/lightning.js'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const CLAIM = 'd'.repeat(64)
const OTHER_CLAIM = 'e'.repeat(64)
const identity = { account: A, groupId: 'trip-1', to: B }

function setup() {
  const db = new Map()
  const store = {
    getItem(key) { return db.get(key) ?? null },
    setItem(key, value) { db.set(key, value) },
    removeItem(key) { db.delete(key) },
  }
  const old = globalThis.localStorage
  globalThis.localStorage = store
  return { db, store, done: () => {
    if (old === undefined) delete globalThis.localStorage
    else globalThis.localStorage = old
  } }
}

test('persists before WebLN receives the invoice and blocks a second payment after refresh', async () => {
  const fixture = setup()
  const oldWindow = globalThis.window
  const oldFetch = globalThis.fetch
  let calls = 0
  try {
    globalThis.fetch = async url => ({ ok: true, json: async () => url.includes('amount=')
      ? { pr: 'lnbc-test-invoice' } : { minSendable: 1000, maxSendable: 100000 } })
    globalThis.window = { webln: {
      enable: async () => {},
      sendPayment: async () => {
        calls++
        assert.equal(getPaymentAttempt(identity)?.status, 'submitted')
        return { preimage: 'f'.repeat(64) }
      },
    } }
    const onSubmission = () => beginPaymentAttempt(identity, 10)
    const payment = await payLightningAddress('alice@example.org', 10, { onWalletSubmission: onSubmission })
    assert.ok(payment.preimage)
    assert.equal(calls, 1)
    // A new module instance / browser refresh reads the same persisted record.
    assert.equal(getPaymentAttempt(identity)?.amount, 10)
    await assert.rejects(payLightningAddress('alice@example.org', 10,
      { onWalletSubmission: onSubmission }), error => error.code === 'PAYMENT_ATTEMPT_PENDING')
    assert.equal(calls, 1)
  } finally {
    fixture.done()
    if (oldWindow === undefined) delete globalThis.window
    else globalThis.window = oldWindow
    if (oldFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = oldFetch
  }
})

test('different accounts, groups and recipients do not see each other’s payment attempts', () => {
  const f = setup()
  try {
    beginPaymentAttempt(identity, 200)
    assert.equal(getPaymentAttempt({ ...identity, account: C }), null)
    assert.equal(getPaymentAttempt({ ...identity, to: C }), null)
    assert.equal(getPaymentAttempt({ ...identity, groupId: 'other' }), null)
  } finally { f.done() }
})

test('amount changes never bypass the debtor-payee lock within the same group', () => {
  const f = setup()
  try {
    beginPaymentAttempt(identity, 200)
    assert.throws(() => beginPaymentAttempt(identity, 250), { code: 'PAYMENT_ATTEMPT_PENDING' })
  } finally { f.done() }
})

test('a storage write failure blocks wallet submission before sending funds', async () => {
  const f = setup()
  const oldWindow = globalThis.window
  const oldFetch = globalThis.fetch
  let sendCalls = 0
  try {
    f.store.setItem = () => { throw Error('Quota exceeded') }
    globalThis.fetch = async url => ({ ok: true, json: async () => url.includes('amount=')
      ? { pr: 'lnbc-test-invoice' } : { minSendable: 1000, maxSendable: 100000 } })
    globalThis.window = { webln: { enable: async () => {},
      sendPayment: async () => { sendCalls++; return { preimage: 'f'.repeat(64) } } } }
    await assert.rejects(payLightningAddress('alice@example.org', 10, {
      onWalletSubmission: () => beginPaymentAttempt(identity, 10),
    }), { code: 'PAYMENT_ATTEMPT_STORAGE_ERROR' })
    assert.equal(sendCalls, 0)
  } finally {
    f.done()
    if (oldWindow === undefined) delete globalThis.window
    else globalThis.window = oldWindow
    if (oldFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = oldFetch
  }
})

test('corrupted journal fails closed rather than silently permitting a second payment', () => {
  const f = setup()
  try {
    beginPaymentAttempt(identity, 50)
    const key = [...f.db.keys()][0]
    f.db.set(key, '{not-json')
    assert.throws(() => getPaymentAttempt(identity), { code: 'PAYMENT_ATTEMPT_CORRUPT' })
    assert.throws(() => beginPaymentAttempt(identity, 50), { code: 'PAYMENT_ATTEMPT_CORRUPT' })
  } finally { f.done() }
})

test('uncertain WebLN outcome persists until explicitly resolved', () => {
  const f = setup()
  try {
    beginPaymentAttempt(identity, 80)
    updatePaymentAttempt(identity, 'outcome-unknown')
    assert.equal(getPaymentAttempt(identity).status, 'outcome-unknown')
    assert.throws(() => beginPaymentAttempt(identity, 80), { code: 'PAYMENT_ATTEMPT_PENDING' })
    assert.throws(() => releaseVerifiedUnpaidAttempt(identity, 'yes'), { code: 'PAYMENT_ATTEMPT_INVALID' })
    assert.equal(getPaymentAttempt(identity).status, 'outcome-unknown')
    assert.equal(releaseVerifiedUnpaidAttempt(identity, 'NESSUN PAGAMENTO'), true)
    assert.equal(getPaymentAttempt(identity), null)
  } finally { f.done() }
})

test('recipient confirmation clears only the exact claimed settlement, never a wallet report alone', () => {
  const f = setup()
  try {
    beginPaymentAttempt(identity, 45)
    updatePaymentAttempt(identity, 'wallet-reported')
    assert.equal(releaseConfirmedPaymentAttempt(identity, CLAIM), false)
    updatePaymentAttempt(identity, 'claim-pending', { claimEventId: CLAIM })
    assert.equal(releaseConfirmedPaymentAttempt(identity, OTHER_CLAIM), false)
    assert.equal(getPaymentAttempt(identity).status, 'claim-pending')
    assert.equal(releaseConfirmedPaymentAttempt({ ...identity, account: C }, CLAIM), false)
    assert.equal(releaseConfirmedPaymentAttempt(identity, CLAIM), true)
    assert.equal(getPaymentAttempt(identity), null)
  } finally { f.done() }
})

test('invalid transitions and claim IDs are rejected; a pending claim stays blocked', () => {
  const f = setup()
  try {
    beginPaymentAttempt(identity, 20)
    assert.throws(() => updatePaymentAttempt(identity, 'claim-pending'), { code: 'PAYMENT_ATTEMPT_INVALID' })
    updatePaymentAttempt(identity, 'wallet-reported')
    assert.throws(() => updatePaymentAttempt(identity, 'submitted'), { code: 'PAYMENT_ATTEMPT_INVALID' })
    assert.throws(() => updatePaymentAttempt(identity, 'claim-pending'), { code: 'PAYMENT_ATTEMPT_INVALID' })
    assert.throws(() => updatePaymentAttempt(identity, 'claim-pending', { claimEventId: 'wrong' }),
      { code: 'PAYMENT_ATTEMPT_INVALID' })
    updatePaymentAttempt(identity, 'claim-pending', { claimEventId: CLAIM })
    assert.throws(() => updatePaymentAttempt(identity, 'outcome-unknown'), { code: 'PAYMENT_ATTEMPT_INVALID' })
    assert.throws(() => releaseVerifiedUnpaidAttempt(identity, 'NESSUN PAGAMENTO'), { code: 'PAYMENT_ATTEMPT_INVALID' })
    assert.throws(() => beginPaymentAttempt(identity, 20), { code: 'PAYMENT_ATTEMPT_PENDING' })
  } finally { f.done() }
})

test('private invoices and preimages are never stored in localStorage', () => {
  const f = setup()
  try {
    beginPaymentAttempt(identity, 100)
    updatePaymentAttempt(identity, 'wallet-reported')
    const bytes = [...f.db.values()].join('\n')
    assert.equal(bytes.includes('lnbc'), false)
    assert.equal(bytes.includes('preimage'), false)
  } finally { f.done() }
})

test('invalid account or group values block persistence', () => {
  const f = setup()
  try {
    assert.throws(() => beginPaymentAttempt({ ...identity, account: 'alice' }, 10),
      { code: 'PAYMENT_ATTEMPT_INVALID' })
    assert.throws(() => beginPaymentAttempt({ ...identity, groupId: '' }, 10),
      { code: 'PAYMENT_ATTEMPT_INVALID' })
    assert.throws(() => beginPaymentAttempt(identity, -1), { code: 'PAYMENT_ATTEMPT_INVALID' })
  } finally { f.done() }
})

test('Web Locks serialize independent tab actions when supported', async () => {
  const { withPaymentOperationLock } = await import('../src/lib/payment-attempts.js')
  const old = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const calls = []
  const queue = []
  Object.defineProperty(globalThis, 'navigator', { configurable: true,
    value: { locks: { request: async (name, options, task) => {
      calls.push([name, options.mode]);
      const prior = queue.at(-1) || Promise.resolve()
      const current = prior.then(task)
      queue.push(current.catch(() => {}))
      return current
    } } },
  })
  try {
    const p1 = withPaymentOperationLock(identity, async () => {
      calls.push('first-start')
      await new Promise(resolve => setTimeout(resolve, 5))
      calls.push('first-finish')
    })
    const p2 = withPaymentOperationLock(identity, () => calls.push('second-start'))
    await Promise.all([p1, p2])
    assert.deepEqual(calls.slice(2), ['first-start', 'first-finish', 'second-start'])
    assert.equal(calls[0][1], 'exclusive')
  } finally {
    if (old) Object.defineProperty(globalThis, 'navigator', old)
    else delete globalThis.navigator
  }
})


test('async signer validation callback rejects before the wallet is invoked', async () => {
  const f = setup()
  const oldWindow = globalThis.window
  const oldFetch = globalThis.fetch
  let calls = 0
  try {
    globalThis.window = { webln: { enable: async () => {}, sendPayment: async () => { calls++ } } }
    globalThis.fetch = async url => ({ ok: true, json: async () => url.includes('amount=')
      ? { pr: 'lnbc-test' } : { minSendable: 1000, maxSendable: 100000 } })
    await assert.rejects(payLightningAddress('alice@example.org', 10, {
      onWalletSubmission: async () => { await Promise.resolve(); throw Error('Signer changed') },
    }), /Signer changed/)
    assert.equal(calls, 0)
    assert.equal(getPaymentAttempt(identity), null)
  } finally {
    f.done()
    if (oldWindow === undefined) delete globalThis.window
    else globalThis.window = oldWindow
    if (oldFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = oldFetch
  }
})


test('external QR is returned only after persisting the attempt and cannot be issued again', async () => {
  const f = setup()
  const oldFetch = globalThis.fetch
  let fetches = 0
  try {
    globalThis.fetch = async () => {
      fetches++
      return { ok: true, json: async () => ({ pr: 'lnbc-qr-test' }) }
    }
    const { invoice, attempt } = await prepareExternalWalletInvoice('alice@example.org', 12, identity, {
      ensureSigner: async () => { assert.equal(getPaymentAttempt(identity), null) },
    })
    assert.equal(invoice, 'lnbc-qr-test')
    assert.equal(attempt.status, 'submitted')
    assert.equal(getPaymentAttempt(identity)?.amount, 12)
    assert.equal(fetches, 1)
    await assert.rejects(
      prepareExternalWalletInvoice('alice@example.org', 12, identity, { ensureSigner: async () => {} }),
      { code: 'PAYMENT_ATTEMPT_PENDING' },
    )
    assert.equal(fetches, 1, 'must reject a duplicate BEFORE asking provider for another invoice')
    assert.equal([...f.db.values()].join('\n').includes(invoice), false, 'do not persist private invoices')
  } finally {
    f.done()
    if (oldFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = oldFetch
  }
})

test('external QR fails closed if signer changes or local storage is unavailable', async () => {
  const f = setup()
  const oldFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ pr: 'lnbc-qr-test' }) })
    await assert.rejects(prepareExternalWalletInvoice('alice@example.org', 25, identity, {
      ensureSigner: async () => { throw Error('Signer changed') },
    }), /Signer changed/)
    assert.equal(getPaymentAttempt(identity), null)
    await assert.rejects(prepareExternalWalletInvoice('alice@example.org', 25, identity),
      /Verifica dell’account Nostr obbligatoria/)
    f.store.setItem = () => { throw Error('Quota exceeded') }
    await assert.rejects(prepareExternalWalletInvoice('alice@example.org', 25, identity, {
      ensureSigner: async () => {},
    }), { code: 'PAYMENT_ATTEMPT_STORAGE_ERROR' })
    assert.equal(f.db.size, 0)
  } finally {
    f.done()
    if (oldFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = oldFetch
  }
})

test('QR reservation and WebLN share the same debtor/group/payee lock', async () => {
  const f = setup()
  const oldFetch = globalThis.fetch
  let walletSubmissions = 0
  const oldWindow = globalThis.window
  try {
    globalThis.fetch = async url => ({ ok: true, json: async () => url.includes('amount=')
      ? { pr: 'lnbc-qr-test' } : { minSendable: 1000, maxSendable: 100000 } })
    await prepareExternalWalletInvoice('alice@example.org', 12, identity, { ensureSigner: async () => {} })
    globalThis.window = { webln: {
      enable: async () => {},
      sendPayment: async () => { walletSubmissions++; return { preimage: 'f'.repeat(64) } },
    } }
    await assert.rejects(payLightningAddress('alice@example.org', 12, {
      onWalletSubmission: () => beginPaymentAttempt(identity, 12),
    }), { code: 'PAYMENT_ATTEMPT_PENDING' })
    assert.equal(walletSubmissions, 0)
  } finally {
    f.done()
    if (oldFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = oldFetch
    if (oldWindow === undefined) delete globalThis.window
    else globalThis.window = oldWindow
  }
})
