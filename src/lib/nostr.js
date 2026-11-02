import { verifyEvent } from 'nostr-tools'
import { nip19 } from 'nostr-tools'
import { RELAYS } from './constants'
import { parseGroupEvent, parseExpenseEvent, parseSettlementEvent } from './event-validation'

// ─── npub ↔ hex conversion ────────────────────────────────────────────────────
// Nostr relays always use hex pubkeys. npub is only a display format.

export function hexToNpub(hex) {
  try { return nip19.npubEncode(hex) } catch { return hex }
}

export function npubToHex(input) {
  if (!input) return input
  if (input.startsWith('npub1')) {
    try {
      const { type, data } = nip19.decode(input)
      if (type === 'npub') return data
    } catch {}
  }
  // Already hex
  return input
}

export function isValidPubkey(input) {
  if (!input) return false
  if (input.startsWith('npub1')) {
    try { const { type } = nip19.decode(input); return type === 'npub' } catch { return false }
  }
  // Hex: 64 lowercase hex chars
  return /^[0-9a-f]{64}$/.test(input)
}

// ─── RelayPool ────────────────────────────────────────────────────────────────

class RelayPool {
  constructor() {
    this._sockets = {}
    this._subs    = {}
    this._seen    = new Set()
    this._queue   = {}
    this._retries = {}
  }

  connect(url) {
    if (this._sockets[url]?.readyState === WebSocket.OPEN) return
    this._queue[url] = this._queue[url] || []
    const ws = new WebSocket(url)
    this._sockets[url] = ws

    ws.onopen = () => {
      this._retries[url] = 0
      ;(this._queue[url] || []).forEach(m => ws.send(m))
      this._queue[url] = []
      Object.entries(this._subs).forEach(([id, sub]) => {
        ws.send(JSON.stringify(['REQ', id, ...sub.filters]))
      })
    }

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg[0] === 'EVENT') {
          const [, subId, event] = msg
          if (!event?.id || !this._subs[subId]) return
          const seenKey = `${subId}:${event.id}`
          if (this._seen.has(seenKey)) return
          try { if (!verifyEvent(event)) return } catch { return }
          this._seen.add(seenKey)
          this._subs[subId]?.onEvent(event)
        } else if (msg[0] === 'EOSE') {
          const sub = this._subs[msg[1]]
          if (sub) {
            sub.eoseCount = (sub.eoseCount || 0) + 1
            if (sub.eoseCount >= Object.keys(this._sockets).length) sub.onEose?.()
          }
        }
      } catch {}
    }

    ws.onerror = () => {}
    ws.onclose = () => {
      const r = this._retries[url] || 0
      this._retries[url] = r + 1
      setTimeout(() => this.connect(url), Math.min(1000 * 2 ** r, 30000))
    }
  }

  _send(msg) {
    const raw = JSON.stringify(msg)
    Object.entries(this._sockets).forEach(([url, ws]) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw)
      else { this._queue[url] = this._queue[url] || []; this._queue[url].push(raw) }
    })
  }

  publish(event) { this._send(['EVENT', event]) }

  subscribe({ id, filters, onEvent, onEose }) {
    const subId = id || Math.random().toString(36).slice(2)
    this._subs[subId] = { filters, onEvent, onEose, eoseCount: 0 }
    this._send(['REQ', subId, ...filters])
    return () => this.unsubscribe(subId)
  }

  unsubscribe(subId) {
    delete this._subs[subId]
    // Forget this subscription's IDs so a subsequent profile refresh can replay them.
    for (const seenKey of this._seen) {
      if (seenKey.startsWith(`${subId}:`)) this._seen.delete(seenKey)
    }
    this._send(['CLOSE', subId])
  }

  get connectedCount() {
    return Object.values(this._sockets).filter(ws => ws.readyState === WebSocket.OPEN).length
  }
}

export const pool = new RelayPool()
RELAYS.forEach(r => pool.connect(r))

// ─── Publish ──────────────────────────────────────────────────────────────────

export async function publishEvent(pubkey, kind, content, tags = []) {
  const event = {
    pubkey, // always hex
    created_at: Math.floor(Date.now() / 1000),
    kind,
    tags,
    content: typeof content === 'string' ? content : JSON.stringify(content),
  }
  const signed = await window.nostr.signEvent(event)
  // Do not publish a forged event if the browser's NIP-07 account changed.
  if (signed.pubkey !== pubkey || signed.kind !== kind || signed.content !== event.content ||
      JSON.stringify(signed.tags) !== JSON.stringify(tags) || !verifyEvent(signed)) {
    throw new Error('Firma Nostr non valida o account del signer cambiato')
  }
  pool.publish(signed)
  return signed
}

// ─── Profile ──────────────────────────────────────────────────────────────────

export function fetchProfile(hexPubkey, onProfile) {
  // Unsubscribe any existing profile sub for this key, then re-subscribe
  // This forces a fresh fetch even if the event was already seen
  pool.unsubscribe('profile_' + hexPubkey)
  return pool.subscribe({
    id:      'profile_' + hexPubkey,
    filters: [{ kinds: [0], authors: [hexPubkey], limit: 1 }],
    onEvent: (event) => {
      try { onProfile(hexPubkey, JSON.parse(event.content)) } catch {}
    },
  })
}

// ─── Groups ──────────────────────────────────────────────────────────────────
// FIX: members are stored as hex internally; npub is only for display.

export function fetchGroups(hexPubkey, onGroup, onDone) {
  let eoseCount = 0
  const checkDone = () => { if (++eoseCount >= 2) onDone?.() }

  const handleGroupEvent = (event) => {
    const group = parseGroupEvent(event, hexPubkey, npubToHex)
    if (group) onGroup(group)
  }

  const unsubAuthored = pool.subscribe({
    id:      'groups_authored_' + hexPubkey,
    filters: [{ kinds: [30001], authors: [hexPubkey], '#t': ['splitsats'], limit: 200 }],
    onEvent: handleGroupEvent,
    onEose:  checkDone,
  })

  const unsubMember = pool.subscribe({
    id:      'groups_member_' + hexPubkey,
    filters: [{ kinds: [30001], '#p': [hexPubkey], '#t': ['splitsats'], limit: 200 }],
    onEvent: handleGroupEvent,
    onEose:  checkDone,
  })

  return () => { unsubAuthored(); unsubMember() }
}

// ─── Expenses ─────────────────────────────────────────────────────────────────

export function subscribeExpenses(groupId, hexMembers, onExpense, onEose) {
  return pool.subscribe({
    id:      'expenses_' + groupId,
    filters: [{ kinds: [9000], authors: hexMembers, '#g': [groupId], limit: 500 }],
    onEvent: (event) => {
      const expense = parseExpenseEvent(event, { id: groupId, members: hexMembers })
      if (expense) onExpense(expense)
    },
    onEose,
  })
}

// ─── Settlements ──────────────────────────────────────────────────────────────

export function subscribeSettlements(groupId, hexMembers, onSettlement, onEose) {
  return pool.subscribe({
    id:      'settlements_' + groupId,
    filters: [{ kinds: [9001], authors: hexMembers, '#g': [groupId], limit: 200 }],
    onEvent: (event) => {
      const settlement = parseSettlementEvent(event, { id: groupId, members: hexMembers })
      if (settlement) onSettlement(settlement)
    },
    onEose,
  })
}