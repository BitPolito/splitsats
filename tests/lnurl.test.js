import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isPublicIpv4, validateHttpsUrl, parseLightningAddress, processLnurlRequest, secureGetJson,
} from '../server/lnurl-core.js'
import lnurlHandler from '../api/lnurl.js'
import { createSignedInvoice, TEST_METADATA } from './helpers/bolt11-fixture.js'

const params = query => new URLSearchParams(query)
const metadata = {
  tag: 'payRequest',
  minSendable: 1000,
  maxSendable: 50000,
  callback: 'https://pay.example.org/invoice?token=signed',
  metadata: TEST_METADATA,
}
const invoice = { pr: createSignedInvoice({ amountMsats: 3000, metadata: TEST_METADATA }) }

const mockProvider = (requests) => async url => {
  requests.push(url)
  if (url.includes('/.well-known/')) return metadata
  return invoice
}

test('rejects private, special and non-IPv4 network destinations', () => {
  for (const ip of [
    '0.0.0.0', '10.1.2.3', '127.0.0.1', '100.64.0.1', '169.254.169.254',
    '172.16.3.4', '192.168.1.1', '192.0.0.2', '192.0.2.1', '198.19.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::1', '::ffff:127.0.0.1', '2002:c0a8:0101::', 'not an ip',
  ]) assert.equal(isPublicIpv4(ip), false, ip)
  assert.equal(isPublicIpv4('1.1.1.1'), true)
  assert.equal(isPublicIpv4('8.8.8.8'), true)
})

test('address parser accepts standard public domains and encodes usernames', () => {
  assert.equal(parseLightningAddress('alice+bob@pay.example.com').toString(),
    'https://pay.example.com/.well-known/lnurlp/alice%2Bbob')
  for (const address of [
    'user@localhost', 'user@127.0.0.1', 'user@169.254.169.254',
    'user@192.168.1.2', 'user@pay.example.com:8443', 'user@a.local',
    'user@a.test', 'user@a.onion', 'user@public.com@127.0.0.1',
    'user@evil.com/path', '@example.com', 'user@example.com:443',
  ]) assert.throws(() => parseLightningAddress(address), undefined, address)
})

test('callback URL validator rejects HTTP, credentials, ports, fragments and IP literals', () => {
  for (const url of [
    'http://pay.example.com/callback', 'https://user:pass@pay.example.com/',
    'https://pay.example.com:444/',
    'https://pay.example.com/path#fragment', 'https://127.0.0.1/',
    'https://[::1]/', 'https://169.254.169.254/',
    'https://pay.example.com@localhost/', 'file:///etc/passwd',
  ]) assert.throws(() => validateHttpsUrl(url), undefined, url)
  assert.equal(validateHttpsUrl('https://pay.example.com/a?key=1').host, 'pay.example.com')
})

test('metadata lookup returns safe public data and never leaks callback', async () => {
  const requests = []
  const output = await processLnurlRequest('GET', params('address=alice%40demo.example.com'), mockProvider(requests))
  assert.deepEqual(output, { status: 200, body: { tag: 'payRequest', minSendable: 1000, maxSendable: 50000 } })
  assert.deepEqual(requests, ['https://demo.example.com/.well-known/lnurlp/alice'])
})

test('invoice callback is read from trusted metadata on the server and amount is enforced', async () => {
  const requests = []
  const output = await processLnurlRequest('GET', params('address=alice%40demo.example.com&amount=3000'), mockProvider(requests))
  assert.deepEqual(output, { status: 200, body: invoice })
  assert.deepEqual(requests, [
    'https://demo.example.com/.well-known/lnurlp/alice',
    'https://pay.example.org/invoice?token=signed&amount=3000',
  ])
})

test('rejects arbitrary callbacks and unknown/duplicated query parameters without requests', async () => {
  for (const query of [
    'callback=https%3A%2F%2F127.0.0.1%2Fsecret&amount=1000',
    'address=alice%40demo.example.com&callback=https%3A%2F%2Fevil.com',
    'address=alice%40demo.example.com&address=bob%40demo.example.com',
    'address=alice%40demo.example.com&amount=1000&amount=2000',
    'address=alice%40demo.example.com&foo=bar',
  ]) {
    const requests = []
    const output = await processLnurlRequest('GET', params(query), mockProvider(requests))
    assert.equal(output.status, 400, query)
    assert.equal(requests.length, 0, query)
  }
})

test('rejects invalid, too-large or out-of-range millisatoshi amounts', async () => {
  for (const amount of ['-1', '0', '1.5', '1e3', 'NaN', '999999999999999999', '100', '51000']) {
    const requests = []
    const output = await processLnurlRequest('GET', params(`address=a%40demo.example.com&amount=${amount}`), mockProvider(requests))
    assert.equal(output.status, 400, amount)
    assert.ok(requests.length <= 1, amount)
  }
})

test('rejects malicious callbacks supplied by metadata before contacting them', async () => {
  for (const callback of [
    'http://10.0.0.1/', 'https://127.0.0.1/admin',
    'https://user:pass@pay.example.com/', 'https://pay.example.com:8443/invoice',
  ]) {
    const requests = []
    const output = await processLnurlRequest('GET', params('address=a%40demo.example.com&amount=1000'), async url => {
      requests.push(url)
      return { ...metadata, callback }
    })
    assert.equal(output.status, 502, callback)
    assert.equal(requests.length, 1)
  }
})

test('rejects malformed metadata and invoice responses', async () => {
  for (const invalid of [
    { ...metadata, tag: 'withdrawRequest' }, { ...metadata, minSendable: -10 },
    { ...metadata, maxSendable: 10 }, { ...metadata, callback: 'javascript:alert(1)' },
  ]) {
    const output = await processLnurlRequest('GET', params('address=a%40demo.example.com'), async () => invalid)
    assert.equal(output.status, 502)
  }
  for (const badInvoice of [
    { status: 'ERROR', reason: 'sensitive server message' },
    { pr: 'not-an-invoice' }, {},
  ]) {
    const output = await processLnurlRequest('GET', params('address=a%40demo.example.com&amount=1000'), async url =>
      url.includes('.well-known') ? metadata : badInvoice)
    assert.equal(output.status, 502)
    assert.ok(!JSON.stringify(output).includes('sensitive server message'))
  }
})

test('LNURL rejects an otherwise signed invoice with wrong amount, metadata, network or expiry', async () => {
  const query = params('address=a%40demo.example.com&amount=3000')
  const invoices = [
    createSignedInvoice({ amountMsats: 4000 }),
    createSignedInvoice({ amountMsats: 3000, metadata: '[["text/plain","other"]]' }),
    createSignedInvoice({ amountMsats: 3000, network: 'tb' }),
    createSignedInvoice({ amountMsats: 3000, timestamp: Math.floor(Date.now()/1000)-7200, expiry: 1 }),
  ]
  for (const pr of invoices) {
    const result = await processLnurlRequest('GET', query, async url =>
      url.includes('/.well-known/') ? metadata : { pr })
    assert.equal(result.status, 502, pr.slice(0, 24))
  }
})

test('LNURL rejects raw metadata without a text/plain entry', async () => {
  const result = await processLnurlRequest('GET', params('address=a%40demo.example.com'), async () => ({
    ...metadata, metadata: JSON.stringify([['image/png;base64', 'xxx']]),
  }))
  assert.equal(result.status, 502)
})

test('only GET and OPTIONS are allowed', async () => {
  assert.equal((await processLnurlRequest('POST', params('address=a%40demo.example.com'))).status, 405)
  assert.equal((await processLnurlRequest('OPTIONS', params(''))).status, 204)
})

test('secure HTTPS transport refuses forbidden destinations before network I/O', async () => {
  await assert.rejects(async () => secureGetJson('http://169.254.169.254/latest/meta-data'))
  await assert.rejects(async () => secureGetJson('https://127.0.0.1/'))
  await assert.rejects(async () => secureGetJson('https://foo.example.com:8080/'))
})

test('Vercel handler exposes the same API semantics with no permissive CORS headers', async () => {
  const headers = {}
  let payload
  const res = {
    setHeader: (key, value) => { headers[key] = value },
    end: body => { payload = body },
    statusCode: 200,
  }
  await lnurlHandler({ method: 'GET', url: '/api/lnurl?callback=https://example.com/&amount=1000' }, res)
  assert.equal(res.statusCode, 400)
  assert.equal(headers['Cache-Control'], 'no-store')
  assert.equal(headers['Access-Control-Allow-Origin'], undefined)
  assert.equal(JSON.parse(payload).error.includes('address'), true)
})
