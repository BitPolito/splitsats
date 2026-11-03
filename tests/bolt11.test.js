import test from 'node:test'
import assert from 'node:assert/strict'
import { bech32 } from '@scure/base'
import { createSignedInvoice, TEST_METADATA, TEST_PREIMAGE } from './helpers/bolt11-fixture.js'
import { validateBolt11Invoice, matchesPaymentPreimage, sha256Utf8Hex } from '../src/lib/bolt11.js'

const NOW = 1800000000
const ok = (options = {}, overrides = {}) => validateBolt11Invoice(createSignedInvoice({
  amountMsats: 12000, timestamp: NOW - 40, expiry: 3600, ...options,
}), { expectedMsats: 12000, expectedDescriptionHash: sha256Utf8Hex(TEST_METADATA), nowSeconds: NOW, ...overrides })

test('accepts a signed LNURL invoice for exact network, amount, metadata and expiry', () => {
  assert.deepEqual(Object.keys(ok()).sort(), ['amountMsats', 'descriptionHash', 'expiresAt', 'network', 'paymentHash', 'timestamp'].sort())
  assert.equal(ok().amountMsats, 12000)
  assert.equal(ok().network, 'bc')
  assert.equal(ok().expiresAt, NOW - 40 + 3600)
  assert.equal(matchesPaymentPreimage(TEST_PREIMAGE, ok().paymentHash), true)
})

test('rejects wrong amount (including same unit different value), testnet and absent amount', () => {
  assert.throws(() => ok({ amountMsats: 13000 }), /importo diverso/)
  assert.throws(() => ok({ network: 'tb' }), /rete Lightning diversa/)
  assert.throws(() => validateBolt11Invoice('lnbc1bad'), /non valida/)
})

test('rejects metadata mismatch and missing required payment secret', () => {
  assert.throws(() => ok({ metadata: JSON.stringify([['text/plain', 'wrong']]) }), /metadata LNURL diversi/)
  assert.throws(() => ok({ includeSecret: false }), /hash, secret o descrizione assenti/)
})

test('rejects expired and future dated invoices', () => {
  assert.throws(() => ok({ timestamp: NOW - 1000, expiry: 900 }), /scaduta/)
  assert.throws(() => ok({ timestamp: NOW + 301 }), /nel futuro/)
})

test('rejects checksum corruption and signed-data tampering', () => {
  const invoice = createSignedInvoice({ amountMsats: 12000, timestamp: NOW - 40 })
  const badChecksum = invoice.slice(0, -1) + (invoice.endsWith('q') ? 'p' : 'q')
  assert.throws(() => validateBolt11Invoice(badChecksum, { nowSeconds: NOW }), /checksum/)
  const decoded = bech32.decode(invoice, 6000)
  const words = [...decoded.words]
  words[15] = (words[15] + 1) % 32
  const tampered = bech32.encode(decoded.prefix, words, 6000)
  assert.throws(() => validateBolt11Invoice(tampered, { nowSeconds: NOW }), /non valida/)
})

test('verifies preimage SHA256 rather than accepting any 64-character hex', () => {
  const hash = ok().paymentHash
  assert.equal(matchesPaymentPreimage(TEST_PREIMAGE, hash), true)
  assert.equal(matchesPaymentPreimage('ff'.repeat(32), hash), false)
  assert.equal(matchesPaymentPreimage('bad', hash), false)
  assert.equal(matchesPaymentPreimage(TEST_PREIMAGE, 'invalid'), false)
})

test('accepts a historical BOLT11 signed reference vector (not just generated fixtures)', () => {
  // Reference: lightning/bolts/11-payment-encoding.md (20m BTC, hashed description)
  const invoice = 'lnbc20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqs9qrsgq7ea976txfraylvgzuxs8kgcw23ezlrszfnh8r6qtfpr6cxga50aj6txm9rxrydzd06dfeawfk6swupvz4erwnyutnjq7x39ymw6j38gp7ynn44'
  const details = validateBolt11Invoice(invoice, {
    network: 'bc', expectedMsats: 2_000_000_000, nowSeconds: 1496314900,
  })
  assert.equal(details.amountMsats, 2_000_000_000)
  assert.equal(details.timestamp, 1496314658)
  assert.equal(details.paymentHash, '0001020304050607080900010203040506070809000102030405060708090102')
})
