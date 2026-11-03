import test from 'node:test'
import assert from 'node:assert/strict'
import { payLightningAddress } from '../src/lib/lightning.js'
import { createSignedInvoice, TEST_PREIMAGE } from './helpers/bolt11-fixture.js'

const PREIMAGE = TEST_PREIMAGE
const ADDRESS = 'alice@example.com'
const INVOICE = createSignedInvoice({ amountMsats: 100000, preimageHex: PREIMAGE })

async function withWallet({ metadata = { minSendable: 1000, maxSendable: 1_000_000 },
  paymentResult = { preimage: PREIMAGE },
  sendPayment = async () => paymentResult,
  fetchFailure = null,
  mock = false,
} = {}, run) {
  const oldWindow = globalThis.window
  const oldFetch = globalThis.fetch
  const trace = []
  const wallet = {
    __splitsatsMock: mock,
    enable: async () => { trace.push('enable') },
    sendPayment: (...args) => { trace.push(['sendPayment', ...args]); return sendPayment(...args) },
  }
  globalThis.window = { webln: wallet }
  globalThis.fetch = async (url) => {
    trace.push(['fetch', url])
    if (fetchFailure) throw fetchFailure
    return { ok: true, json: async () => url.includes('amount=') ? { pr: INVOICE } : metadata }
  }
  try { await run(trace) } finally {
    if (oldWindow === undefined) delete globalThis.window
    else globalThis.window = oldWindow
    if (oldFetch === undefined) delete globalThis.fetch
    else globalThis.fetch = oldFetch
  }
}

test('successful WebLN reports exactly one wallet submission and returns wallet result', async () => {
  await withWallet({}, async trace => {
    let submitted = 0
    const result = await payLightningAddress(ADDRESS, 100, {
      onWalletSubmission: () => { trace.push('submitted'); submitted++ },
    })
    assert.deepEqual(result, { preimage: PREIMAGE, invoice: INVOICE })
    assert.equal(submitted, 1)
    assert.deepEqual(trace.slice(-2), ['submitted', ['sendPayment', INVOICE]])
  })
})

test('WebLN rejection after submission is uncertain, not a safe retry signal', async () => {
  await withWallet({ sendPayment: async () => { throw Error('wallet disconnected') } }, async trace => {
    await assert.rejects(payLightningAddress(ADDRESS, 100, {
      onWalletSubmission: () => trace.push('submitted'),
    }), error => error.code === 'WALLET_PAYMENT_OUTCOME_UNKNOWN' &&
      error.cause?.message === 'wallet disconnected')
    assert.equal(trace.filter(e => e === 'submitted').length, 1)
    assert.equal(trace.filter(e => Array.isArray(e) && e[0] === 'sendPayment').length, 1)
  })
})

test('synchronous WebLN error is also an uncertain outcome', async () => {
  await withWallet({ sendPayment: () => { throw Error('wallet extension crashed') } }, async () => {
    await assert.rejects(payLightningAddress(ADDRESS, 100), {
      code: 'WALLET_PAYMENT_OUTCOME_UNKNOWN',
    })
  })
})

test('missing or malformed WebLN preimage is not treated as success', async () => {
  for (const paymentResult of [{}, null, { preimage: 'not-hex' }, { preimage: 'a'.repeat(63) }]) {
    await withWallet({ paymentResult }, async () => {
      await assert.rejects(payLightningAddress(ADDRESS, 100), {
        code: 'WALLET_PAYMENT_OUTCOME_UNKNOWN',
      })
    })
  }
})

test('wallet-reported 64-hex preimage with wrong hash is uncertain and blocks settlement', async () => {
  await withWallet({ paymentResult: { preimage: 'ff'.repeat(32) } }, async trace => {
    await assert.rejects(payLightningAddress(ADDRESS, 100), {
      code: 'WALLET_PAYMENT_OUTCOME_UNKNOWN',
    })
    assert.equal(trace.filter(e => Array.isArray(e) && e[0] === 'sendPayment').length, 1)
  })
})

test('invoice amount tampering is stopped before calling WebLN', async () => {
  const oldFetch = globalThis.fetch
  await withWallet({}, async trace => {
    globalThis.fetch = async url => ({ ok: true, json: async () => url.includes('amount=')
      ? { pr: createSignedInvoice({ amountMsats: 200000 }) }
      : { minSendable: 1000, maxSendable: 1000000 } })
    let submitted = 0
    await assert.rejects(payLightningAddress(ADDRESS, 100, { onWalletSubmission: () => submitted++ }), /importo diverso/)
    assert.equal(submitted, 0)
    assert.equal(trace.some(e => Array.isArray(e) && e[0] === 'sendPayment'), false)
  })
  globalThis.fetch = oldFetch
})

test('invoice lookup failure occurs before wallet submission and permits a safe retry', async () => {
  await withWallet({ fetchFailure: new Error('LNURL offline') }, async trace => {
    await assert.rejects(payLightningAddress(ADDRESS, 100, {
      onWalletSubmission: () => trace.push('submitted'),
    }), error => error.message === 'LNURL offline' && error.code === undefined)
    assert.equal(trace.includes('submitted'), false)
    assert.equal(trace.some(e => Array.isArray(e) && e[0] === 'sendPayment'), false)
  })
})

test('out of range invoice amount is rejected before sending anything to WebLN', async () => {
  await withWallet({ metadata: { minSendable: 200_000, maxSendable: 300_000 } }, async trace => {
    await assert.rejects(payLightningAddress(ADDRESS, 100, {
      onWalletSubmission: () => trace.push('submitted'),
    }), /Minimo/)
    assert.equal(trace.includes('submitted'), false)
    assert.equal(trace.some(e => Array.isArray(e) && e[0] === 'sendPayment'), false)
  })
})

test('wallet submission callback failure happens before sendPayment', async () => {
  await withWallet({}, async trace => {
    await assert.rejects(payLightningAddress(ADDRESS, 100, {
      onWalletSubmission: () => { throw new Error('Cannot record attempt') },
    }), error => error.message === 'Cannot record attempt' && error.code === undefined)
    assert.equal(trace.some(e => Array.isArray(e) && e[0] === 'sendPayment'), false)
  })
})

test('development WebLN mock is blocked before invoice retrieval or submission', async () => {
  await withWallet({ mock: true }, async trace => {
    await assert.rejects(payLightningAddress(ADDRESS, 100, {
      onWalletSubmission: () => trace.push('submitted'),
    }), /Wallet simulato/)
    assert.equal(trace.includes('submitted'), false)
    assert.equal(trace.some(e => Array.isArray(e) && e[0] === 'fetch'), false)
  })
})
