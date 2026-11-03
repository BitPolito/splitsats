// Deterministic signed test invoices; never use this key for real funds.
import { bech32 } from '@scure/base'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { packBolt11Words } from '../../src/lib/bolt11.js'

export const TEST_PREIMAGE = 'ab'.repeat(32)
export const TEST_METADATA = JSON.stringify([['text/plain', 'SplitSats test payment']])
const TEST_SIGNING_KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const chars = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const bytes = hex => Uint8Array.from(hex.match(/.{2}/g), b => parseInt(b, 16))
const asWords = (value, length) => {
  let n = BigInt(value)
  const result = []
  do { result.unshift(Number(n & 31n)); n >>= 5n } while (n)
  while (length && result.length < length) result.unshift(0)
  return result
}
const tag = (char, payload) => {
  const words = Array.isArray(payload) ? payload : bech32.toWords(payload)
  return [chars.indexOf(char), words.length >> 5, words.length & 31, ...words]
}
export function createSignedInvoice({ amountMsats = 3000, metadata = TEST_METADATA,
  preimageHex = TEST_PREIMAGE, timestamp = Math.floor(Date.now() / 1000),
  expiry = 3600, network = 'bc', descriptionHash,
  includeSecret = true, includePayee = true } = {}) {
  if (!Number.isSafeInteger(amountMsats) || amountMsats < 1) throw Error('invalid test amount')
  const units = amountMsats % 100 === 0 ? `${amountMsats / 100}n` : `${amountMsats * 10}p`
  const hrp = `ln${network}${units}`
  const hash = descriptionHash ?? sha256(new TextEncoder().encode(metadata))
  const words = [
    ...asWords(timestamp, 7),
    ...tag('p', sha256(bytes(preimageHex))),
    ...(includeSecret ? tag('s', new Uint8Array(32).fill(17)) : []),
    ...tag('h', hash),
    ...(includePayee ? tag('n', secp256k1.getPublicKey(TEST_SIGNING_KEY)) : []),
    ...tag('x', asWords(expiry)),
  ]
  const text = new TextEncoder().encode(hrp)
  const data = packBolt11Words(words)
  const signedBytes = new Uint8Array(text.length + data.length)
  signedBytes.set(text); signedBytes.set(data, text.length)
  const recovered = secp256k1.sign(signedBytes, TEST_SIGNING_KEY, { format: 'recovered' })
  const signature = Uint8Array.of(...recovered.subarray(1), recovered[0])
  return bech32.encode(hrp, [...words, ...bech32.toWords(signature)], 6000)
}
