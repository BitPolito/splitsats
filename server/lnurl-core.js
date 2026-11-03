// Shared LNURL-pay backend used by Vercel's Node.js function and Vite dev server.
// NEVER use fetch() for these user-influenced upstream requests: Node's HTTPS
// client pins each connection to an IP verified by safeLookup (DNS rebinding).
import { lookup } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { validateBolt11Invoice, sha256Utf8Hex } from '../src/lib/bolt11.js'

const MAX_RESPONSE_BYTES = 64 * 1024
const UPSTREAM_TIMEOUT_MS = 7000
const MAX_AMOUNT_MSATS = Number.MAX_SAFE_INTEGER

export class LnurlError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'LnurlError'
    this.status = status
  }
}

export function isPublicIpv4(address) {
  if (isIP(address) !== 4) return false
  const [a, b, c] = address.split('.').map(Number)
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local and metadata endpoints
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  )
}

function isValidDomain(hostname) {
  if (typeof hostname !== 'string' || hostname.length > 253 || hostname.length < 4) return false
  if (isIP(hostname) || /\.(?:local|localhost|internal|test|invalid|example|onion|arpa)$/i.test(hostname)) return false
  const labels = hostname.split('.')
  return labels.length >= 2 && labels.every(label =>
    label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ) && /[a-z]/i.test(labels[labels.length - 1])
}

export function validateHttpsUrl(input) {
  let url
  try { url = new URL(input) } catch { throw new LnurlError('URL LNURL non valido', 502) }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !isValidDomain(url.hostname)) {
    throw new LnurlError('Host LNURL non consentito: solo domini pubblici HTTPS sulla porta standard', 502)
  }
  return url
}

export function parseLightningAddress(address) {
  if (typeof address !== 'string' || address.length > 320) throw new LnurlError('Lightning Address non valido')
  const parts = address.split('@')
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64 ||
      !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(parts[0]) || !isValidDomain(parts[1])) {
    throw new LnurlError('Lightning Address non valido')
  }
  const url = new URL(`https://${parts[1]}/.well-known/lnurlp/${encodeURIComponent(parts[0])}`)
  validateHttpsUrl(url.toString())
  return url
}

// HTTPS connects using the *same* public IPv4 that we validated. We deliberately
// require an A record; IPv6-only endpoints are unsupported until an equivalent
// IPv6 global-route classifier is added. This avoids IPv4-mapped/6to4 bypasses.
export function safeLookup(hostname, _options, callback) {
  lookup(hostname, { family: 4, all: true, verbatim: true }, (error, addresses) => {
    if (error || !addresses?.length || addresses.some(item => !isPublicIpv4(item.address))) {
      callback(new Error('Destinazione di rete non consentita'))
      return
    }
    callback(null, addresses[0].address, 4)
  })
}

export function secureGetJson(input) {
  const url = validateHttpsUrl(input)
  return new Promise((resolve, reject) => {
    let complete = false
    const finish = (error, value) => {
      if (complete) return
      complete = true
      clearTimeout(deadline)
      if (error) reject(error)
      else resolve(value)
    }
    const req = httpsRequest(url, {
      method: 'GET',
      lookup: safeLookup,
      family: 4,
      agent: false,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
    }, (response) => {
      // No redirects, even if the provider tries to redirect to a private host.
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume()
        finish(new LnurlError('Il server Lightning non ha risposto correttamente', 502))
        return
      }
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy()
          finish(new LnurlError('Risposta Lightning troppo grande', 502))
        } else chunks.push(chunk)
      })
      response.on('error', () => finish(new LnurlError('Errore nella risposta Lightning', 502)))
      response.on('end', () => {
        if (complete) return
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Unexpected JSON')
          finish(null, data)
        } catch { finish(new LnurlError('Risposta Lightning non valida', 502)) }
      })
    })
    const deadline = setTimeout(() => {
      req.destroy()
      finish(new LnurlError('Timeout dal server Lightning', 502))
    }, UPSTREAM_TIMEOUT_MS)
    req.on('error', () => finish(new LnurlError('Impossibile raggiungere il server Lightning', 502)))
    req.end()
  })
}

function validatePayMetadata(value) {
  if (!value || value.tag !== 'payRequest' ||
      !Number.isSafeInteger(value.minSendable) || value.minSendable < 1 ||
      !Number.isSafeInteger(value.maxSendable) || value.maxSendable < value.minSendable ||
      typeof value.callback !== 'string') {
    throw new LnurlError('Metadati LNURL-pay non validi', 502)
  }
  validateHttpsUrl(value.callback)
  // LNURL-pay defines metadata as a raw JSON *string*. Preserve its bytes:
  // BOLT11's h tag commits to SHA256 of that exact string, not re-serialized JSON.
  if (typeof value.metadata !== 'string' || value.metadata.length > MAX_RESPONSE_BYTES) {
    throw new LnurlError('Metadata LNURL-pay mancanti o troppo grandi', 502)
  }
  let entries
  try { entries = JSON.parse(value.metadata) }
  catch { throw new LnurlError('Metadata LNURL-pay non validi', 502) }
  if (!Array.isArray(entries) || !entries.length ||
      !entries.every(e => Array.isArray(e) && e.length >= 2 && typeof e[0] === 'string') ||
      !entries.some(e => e[0] === 'text/plain' && typeof e[1] === 'string')) {
    throw new LnurlError('Metadata LNURL-pay senza text/plain', 502)
  }
  return value
}

function parseAmount(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new LnurlError('Importo millisatoshi non valido')
  }
  const amount = Number(value)
  if (!Number.isSafeInteger(amount) || amount > MAX_AMOUNT_MSATS) {
    throw new LnurlError('Importo fuori intervallo')
  }
  return amount
}

// Only accepts a Lightning Address; the client can no longer choose the URL
// of the upstream callback. The callback is resolved and verified server-side
// for every invoice request (no client-controlled cache or forged metadata).
export async function processLnurlRequest(method, params, getJson = secureGetJson) {
  if (method === 'OPTIONS') return { status: 204, body: null }
  if (method !== 'GET') return { status: 405, body: { error: 'Metodo non consentito' } }
  try {
    const addresses = params.getAll('address')
    const amounts = params.getAll('amount')
    if (addresses.length !== 1 || amounts.length > 1 || params.has('callback') ||
        [...params.keys()].some(key => !['address', 'amount'].includes(key))) {
      throw new LnurlError('Specificare address e, opzionalmente, amount')
    }
    const addressUrl = parseLightningAddress(addresses[0])
    const amount = amounts.length ? parseAmount(amounts[0]) : null
    const metadata = validatePayMetadata(await getJson(addressUrl.toString()))

    if (amount === null) {
      return { status: 200, body: {
        tag: 'payRequest', minSendable: metadata.minSendable, maxSendable: metadata.maxSendable,
      } }
    }
    if (amount < metadata.minSendable || amount > metadata.maxSendable) {
      throw new LnurlError('Importo fuori dai limiti LNURL-pay')
    }
    const callbackUrl = validateHttpsUrl(metadata.callback)
    callbackUrl.searchParams.set('amount', String(amount))
    const invoice = await getJson(callbackUrl.toString())
    if (!invoice || invoice.status === 'ERROR') {
      throw new LnurlError('Il server Lightning ha rifiutato la richiesta', 502)
    }
    try {
      validateBolt11Invoice(invoice.pr, {
        expectedMsats: amount,
        expectedDescriptionHash: sha256Utf8Hex(metadata.metadata),
        network: 'bc',
      })
    } catch {
      throw new LnurlError('Invoice BOLT11 non valida: importo, hash metadata, rete, firma o scadenza', 502)
    }
    return { status: 200, body: { pr: invoice.pr } }
  } catch (error) {
    if (error instanceof LnurlError) return { status: error.status, body: { error: error.message } }
    return { status: 502, body: { error: 'Impossibile completare la richiesta LNURL' } }
  }
}
