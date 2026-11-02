import { verifyEvent } from 'nostr-tools'
import { nip19 } from 'nostr-tools'
import { RELAYS } from './constants'
import { RelayPool } from './relay-pool'
import { parseGroupEvent, parseExpenseEvent, parseSettlementEvent, parseConfirmationEvent } from './event-validation'

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

// A relay acknowledging an event (NIP-20 OK) is required before we show
// an optimistic local mutation. Subscriptions retry after reconnect.
export const pool = new RelayPool({ verifyEvent })
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
  await pool.publish(signed)
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
// ─── Recipient-signed payment confirmations ─────────────────────────────────
export function subscribeConfirmations(groupId, hexMembers, onConfirmation, onEose) {
  return pool.subscribe({
    id:      'confirmations_' + groupId,
    filters: [{ kinds: [9002], authors: hexMembers, '#g': [groupId], limit: 200 }],
    onEvent: event => {
      const confirmation = parseConfirmationEvent(event, { id: groupId, members: hexMembers })
      if (confirmation) onConfirmation(confirmation)
    },
    onEose,
  })
}
