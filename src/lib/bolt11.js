// Shared BOLT11 validator for the LNURL backend and browser payment flow.
// A syntactically valid 'lnbc...' string is NOT an invoice validation.
// Inputs from an LNURL provider must be verified before exposing to a wallet.
import { bech32 } from '@scure/base'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const HEX_32 = /^[a-f0-9]{64}$/i
const AMOUNT_FACTORS_MSAT = { '': 100000000000n, m: 100000000n, u: 100000n, n: 100n }
const MAX_INVOICE_CHARS = 6000

function invalid(reason) {
  const error = new Error(`Invoice BOLT11 non valida: ${reason}`)
  error.code = 'BOLT11_INVALID'
  return error
}

function hex(bytes) { return Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('') }
function bytesFromHex(value) {
  if (typeof value !== 'string' || !HEX_32.test(value)) throw invalid('hash esadecimale non valido')
  return Uint8Array.from(value.match(/.{2}/g), n => parseInt(n, 16))
}
function equalBytes(left, right) {
  if (left.length !== right.length) return false
  let result = 0
  for (let i = 0; i < left.length; i++) result |= left[i] ^ right[i]
  return result === 0
}
function concat(left, right) {
  const output = new Uint8Array(left.length + right.length)
  output.set(left, 0); output.set(right, left.length)
  return output
}

// BOLT11 signatures hash HRP bytes || 5-bit words packed as bytes, padding
// *the signed data* with zero bits to a byte boundary (not the 65-byte signature).
export function packBolt11Words(words) {
  const output = []
  let bits = 0; let acc = 0
  for (const word of words) {
    if (!Number.isInteger(word) || word < 0 || word > 31) throw invalid('word bech32 errata')
    acc = (acc << 5) | word
    bits += 5
    if (bits >= 8) {
      bits -= 8
      output.push((acc >>> bits) & 255)
      acc &= (1 << bits) - 1
    }
  }
  if (bits) output.push((acc << (8 - bits)) & 255)
  return Uint8Array.from(output)
}

function integerWords(words) {
  let result = 0n
  for (const n of words) result = (result << 5n) + BigInt(n)
  return result
}
function parseAmount(hrp) {
  const m = /^ln(bc|tb|bcrt)([1-9][0-9]*)([munp]?)$/.exec(hrp)
  if (!m) throw invalid('rete o importo assente')
  const number = BigInt(m[2])
  const amount = m[3] === 'p' ? (number % 10n === 0n ? number / 10n : null)
    : number * AMOUNT_FACTORS_MSAT[m[3]]
  if (amount === null || amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalid('importo millisatoshi non rappresentabile')
  }
  return { network: m[1], amountMsats: Number(amount) }
}

export function validateBolt11Invoice(invoice, { expectedMsats, expectedDescriptionHash,
  network = 'bc', nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof invoice !== 'string' || invoice.length > MAX_INVOICE_CHARS || invoice.length < 130) {
    throw invalid('lunghezza o formato errati')
  }
  let decoded
  try { decoded = bech32.decode(invoice, MAX_INVOICE_CHARS) }
  catch { throw invalid('checksum bech32 errato') }
  const { prefix: hrp, words } = decoded
  const { network: actualNetwork, amountMsats } = parseAmount(hrp)
  if (actualNetwork !== network) throw invalid('rete Lightning diversa da quella prevista')
  if (expectedMsats !== undefined && (!Number.isSafeInteger(expectedMsats) ||
      expectedMsats <= 0 || amountMsats !== expectedMsats)) throw invalid('importo diverso da quello richiesto')
  if (words.length < 7 + 104) throw invalid('dati o firma mancanti')

  const signedWords = words.slice(0, -104)
  const signatureWords = words.slice(-104)
  const tags = {}
  const tagCounts = new Map()
  const timestamp = Number(integerWords(signedWords.slice(0, 7)))
  let cursor = 7
  while (cursor < signedWords.length) {
    if (cursor + 3 > signedWords.length) throw invalid('tag troncato')
    const type = CHARSET[signedWords[cursor++]]
    const length = signedWords[cursor++] * 32 + signedWords[cursor++]
    if (cursor + length > signedWords.length) throw invalid('lunghezza tag non valida')
    const data = signedWords.slice(cursor, cursor + length)
    cursor += length
    if (!'pshdnx'.includes(type)) continue
    const count = (tagCounts.get(type) || 0) + 1
    tagCounts.set(type, count)
    if (count > 1) throw invalid('tag obbligatorio duplicato')
    if (['p', 's', 'h'].includes(type) && length !== 52) throw invalid('dimensione hash non valida')
    if (type === 'n' && length !== 53) throw invalid('dimensione pubkey non valida')
    if (['p', 's', 'h', 'n'].includes(type)) {
      try { tags[type] = bech32.fromWords(data) }
      catch { throw invalid('padding del tag non valido') }
    } else if (type === 'x') {
      if (!data.length) throw invalid('scadenza non valida')
      tags.x = integerWords(data)
    } else {
      tags.d = data
    }
  }
  if (!tags.p || !tags.s || (!!tags.d === !!tags.h)) throw invalid('hash, secret o descrizione assenti')
  if (tags.p.length !== 32 || tags.s.length !== 32) throw invalid('hash o secret errati')
  if (tags.h && tags.h.length !== 32) throw invalid('description hash errata')
  if (tags.n && tags.n.length !== 33) throw invalid('pubkey errata')
  if (expectedDescriptionHash !== undefined &&
      (!tags.h || !equalBytes(tags.h, bytesFromHex(expectedDescriptionHash)))) {
    throw invalid('metadata LNURL diversi dalla invoice')
  }

  const expiry = tags.x === undefined ? 3600n : tags.x
  const expiresAt = BigInt(timestamp) + expiry
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0 ||
      BigInt(timestamp) > BigInt(nowSeconds) + 300n || expiresAt <= BigInt(nowSeconds) ||
      expiresAt > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid('invoice scaduta o nel futuro')

  let signature
  try { signature = bech32.fromWords(signatureWords) }
  catch { throw invalid('firma mal codificata') }
  if (signature.length !== 65 || signature[64] > 3) throw invalid('firma non valida')
  const msg = concat(new TextEncoder().encode(hrp), packBolt11Words(signedWords))
  try {
    // Noble's recovered encoding places recovery id BEFORE compact (r||s),
    // whereas BOLT11 places it AFTER (r||s). Noble v2 hashes msg itself.
    const recovered = Uint8Array.of(signature[64], ...signature.subarray(0, 64))
    const pubkey = secp256k1.recoverPublicKey(recovered, msg)
    if (tags.n && !equalBytes(tags.n, pubkey)) throw invalid('firma diversa dal nodo destinatario')
    if (!secp256k1.verify(signature.subarray(0, 64), msg, pubkey,
      { lowS: !!tags.n })) throw invalid('firma ECDSA non valida')
  } catch { throw invalid('firma ECDSA non valida') }

  return { network: actualNetwork, amountMsats, paymentHash: hex(tags.p),
    descriptionHash: tags.h ? hex(tags.h) : null, timestamp, expiresAt: Number(expiresAt) }
}

export function matchesPaymentPreimage(preimageHex, expectedPaymentHash) {
  if (typeof preimageHex !== 'string' || !HEX_32.test(preimageHex) ||
      typeof expectedPaymentHash !== 'string' || !HEX_32.test(expectedPaymentHash)) return false
  return equalBytes(sha256(bytesFromHex(preimageHex)), bytesFromHex(expectedPaymentHash))
}

export function sha256Utf8Hex(text) {
  if (typeof text !== 'string') throw invalid('metadata non testuali')
  return hex(sha256(new TextEncoder().encode(text)))
}
