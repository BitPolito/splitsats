// Browser E2E harness; NEVER imported by production code.
// The app uses real Nostr signing/verification. Only the relay transport and
// NIP-07 browser extension boundary are simulated. No Lightning payments occur.
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools'

export const testSigner = (byte) => {
  if (!Number.isInteger(byte) || byte < 1 || byte > 255) throw Error('Invalid test identity')
  const secret = new Uint8Array(32).fill(byte) // TEST-ONLY secret, never for real funds.
  return { secret, pubkey: getPublicKey(secret) }
}

const hasTag = (event, key, options) =>
  event.tags.some(tag => tag[0] === key && options.includes(tag[1]))

function matches(event, filter) {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.authors && !filter.authors.some(a => event.pubkey.startsWith(a))) return false
  if (filter.ids && !filter.ids.some(id => event.id.startsWith(id))) return false
  for (const [key, options] of Object.entries(filter)) {
    if (key.startsWith('#') && !hasTag(event, key.slice(1), options)) return false
  }
  return true
}

export class MemoryNostrRelay {
  constructor() {
    this.events = new Map()
    this.channels = new Set()
    this.acceptEvents = true
  }

  async attach(context) {
    // Intercept ALL app relay URLs before the first page is created.
    // No real connection to public Nostr relays leaves these tests.
    await context.routeWebSocket(/^wss:\/\//, socket => {
      const subscriptions = new Map()
      const channel = { socket, subscriptions }
      this.channels.add(channel)
      socket.onMessage(raw => {
        let message
        try { message = JSON.parse(raw) } catch { return }
        if (!Array.isArray(message)) return
        if (message[0] === 'REQ' && typeof message[1] === 'string') {
          const [, id, ...filters] = message
          if (!filters.length) return
          subscriptions.set(id, filters)
          for (const event of this.events.values()) {
            if (filters.some(filter => matches(event, filter))) {
              socket.send(JSON.stringify(['EVENT', id, event]))
            }
          }
          socket.send(JSON.stringify(['EOSE', id]))
        } else if (message[0] === 'CLOSE') {
          subscriptions.delete(message[1])
        } else if (message[0] === 'EVENT') {
          const event = message[1]
          if (!this.acceptEvents) return // Simulates a relay that never ACKs.
          if (!verifyEvent(event)) {
            socket.send(JSON.stringify(['OK', event?.id || '', false, 'invalid signature']))
            return
          }
          const fresh = !this.events.has(event.id)
          this.events.set(event.id, event)
          // The publication ACK is sent before streaming the event back to
          // subscribers, as many relays do. Clients must still dedupe.
          socket.send(JSON.stringify(['OK', event.id, true, 'stored']))
          if (fresh) {
            for (const peer of this.channels) {
              for (const [id, filters] of peer.subscriptions) {
                if (filters.some(filter => matches(event, filter))) {
                  peer.socket.send(JSON.stringify(['EVENT', id, event]))
                }
              }
            }
          }
        }
      })
    })
  }
}

export async function openSignedClient(browser, relay, identity) {
  const context = await browser.newContext()
  await relay.attach(context)
  const page = await context.newPage()
  // Cryptographic signing is performed in the Node test runner, not with a
  // fake signature and not by injecting test private keys into the browser.
  await page.exposeFunction('__splitsatsE2ESign', async unsigned => finalizeEvent(unsigned, identity.secret))
  await page.addInitScript(pubkey => {
    window.nostr = {
      getPublicKey: async () => pubkey,
      signEvent: async unsigned => window.__splitsatsE2ESign(unsigned),
    }
  }, identity.pubkey)
  await page.goto('/')
  return { context, page, pubkey: identity.pubkey }
}
