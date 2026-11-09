import { matchesGroupAddressTag } from './group-history.js'
import { isReadableSplitSatsSchema } from './protocol-schema.js'

// Validate application-level authorization and payloads AFTER the relay event's
// Nostr signature has been checked. An authentic signature does not mean that
// the signer is allowed to change a group's balances.

const HEX_KEY = /^[0-9a-f]{64}$/
const HEX_EVENT = HEX_KEY
const MAX_FUTURE_SECONDS = 300

export const validPubkey = value => typeof value === 'string' && HEX_KEY.test(value)
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const positiveSats = value => Number.isSafeInteger(value) && value > 0
const nonemptyString = (value, max) => typeof value === 'string' && !!value.trim() && value.length <= max

function taggedValues(event, tag) {
  if (!Array.isArray(event?.tags)) return null
  if (!event.tags.every(t => Array.isArray(t) && t.length >= 2 && typeof t[0] === 'string' && typeof t[1] === 'string')) return null
  return event.tags.filter(t => t[0] === tag).map(t => t[1])
}

function hasSingleTag(event, tag, value) {
  const tags = taggedValues(event, tag)
  return tags !== null && tags.length === 1 && tags[0] === value
}

function isValidEnvelope(event, kind) {
  return event && event.kind === kind && HEX_EVENT.test(event.id || '') &&
    validPubkey(event.pubkey) && Number.isSafeInteger(event.created_at) &&
    event.created_at > 0 && event.created_at <= Math.floor(Date.now() / 1000) + MAX_FUTURE_SECONDS &&
    hasSingleTag(event, 't', 'splitsats') && typeof event.content === 'string'
}

function readObject(content, kind) {
  try { const value = JSON.parse(content); return plainObject(value) &&
    isReadableSplitSatsSchema(kind, value) ? value : null } catch { return null }
}

function validMembers(members) {
  return Array.isArray(members) && members.length >= 1 && members.length <= 100 &&
    members.every(validPubkey) && new Set(members).size === members.length
}

function exactMemberTags(event, members) {
  const tags = taggedValues(event, 'p')
  return tags !== null && tags.length === members.length &&
    new Set(tags).size === tags.length && tags.every(t => members.includes(t))
}

// NIP-33: addressable groups are keyed by (author, kind, d-tag).
export function parseGroupEvent(event, viewerPubkey, normalizeMember = value => value) {
  if (!isValidEnvelope(event, 30001) || !validPubkey(viewerPubkey)) return null
  const d = taggedValues(event, 'd')
  if (!d || d.length !== 1 || !nonemptyString(d[0], 128)) return null
  const data = readObject(event.content, event.kind)
  if (!data || !nonemptyString(data.name, 100) || !Array.isArray(data.members)) return null
  let members
  try { members = data.members.map(normalizeMember) } catch { return null }
  if (!validMembers(members) || !members.includes(event.pubkey) || !members.includes(viewerPubkey) ||
      !exactMemberTags(event, members)) return null
  // Reject an event whose content claims a different group from its signed d-tag.
  if (data.id !== undefined && data.id !== d[0]) return null
  // A signed pointer to the immutable revision log is authoritative.
  const r = taggedValues(event, 'r')
  if (!r || r.length > 1 || (data.revisionEventId === undefined
    ? r.length !== 0
    : !HEX_EVENT.test(data.revisionEventId) || r.length !== 1 || r[0] !== data.revisionEventId)) return null
  return {
    id: d[0], name: data.name.trim(), members,
    createdAt: Number.isSafeInteger(data.createdAt) ? data.createdAt : event.created_at,
    pubkey: event.pubkey, eventId: event.id, _groupCreatedAt: event.created_at,
    _revisionId: data.revisionEventId || null,
  }
}

// Newer revision wins regardless of relay arrival order. A different signer
// cannot overwrite an existing group's definition by reusing its short d-tag.
export function isNewerGroupDefinition(existing, incoming) {
  if (!existing) return true
  if (existing.pubkey && existing.pubkey !== incoming.pubkey) return false
  if (existing.eventId === incoming.eventId) return false
  if (!Number.isSafeInteger(existing._groupCreatedAt)) return true // legacy cache
  if (incoming._groupCreatedAt !== existing._groupCreatedAt) {
    return incoming._groupCreatedAt > existing._groupCreatedAt
  }
  return incoming.eventId > (existing.eventId || '')
}

function validGroup(group) {
  return group && nonemptyString(group.id, 128) && validMembers(group.members)
}

export function parseExpenseEvent(event, group) {
  if (!isValidEnvelope(event, 9000) || !validGroup(group) ||
      !hasSingleTag(event, 'g', group.id) || !matchesGroupAddressTag(event, group) ||
      !group.members.includes(event.pubkey)) return null
  const data = readObject(event.content, event.kind)
  if (!data || !nonemptyString(data.id, 128) || !nonemptyString(data.description, 500) ||
      !positiveSats(data.amount) || !group.members.includes(data.paidBy) ||
      !Array.isArray(data.splits) || data.splits.length === 0 ||
      new Set(data.splits).size !== data.splits.length ||
      !data.splits.every(m => group.members.includes(m))) return null
  return {
    id: data.id, description: data.description, amount: data.amount,
    paidBy: data.paidBy, splits: data.splits,
    category: typeof data.category === 'string' && data.category.length <= 32 ? data.category : 'other',
    createdAt: Number.isSafeInteger(data.createdAt) ? data.createdAt : event.created_at,
    _eventId: event.id, _pubkey: event.pubkey,
  }
}

export function parseSettlementEvent(event, group) {
  if (!isValidEnvelope(event, 9001) || !validGroup(group) ||
      !hasSingleTag(event, 'g', group.id) || !matchesGroupAddressTag(event, group)) return null
  const data = readObject(event.content, event.kind)
  // Only the debtor can attest to sending a payment. This is still NOT a
  // cryptographic proof that any Lightning transfer was completed.
  if (!data || event.pubkey !== data.from || !group.members.includes(data.from) ||
      !group.members.includes(data.to) || data.from === data.to || !positiveSats(data.amount) ||
      !hasSingleTag(event, 'p', data.to) ||
      (data.id !== undefined && !nonemptyString(data.id, 128))) return null
  if (data.method !== undefined && !['manual', 'webln'].includes(data.method)) return null
  return {
    id: data.id || event.id, from: data.from, to: data.to, amount: data.amount,
    method: data.method || 'legacy', walletReported: data.method === 'webln' && data.walletReported === true,
    settledAt: Number.isSafeInteger(data.settledAt) ? data.settledAt : event.created_at,
    _eventId: event.id, _pubkey: event.pubkey,
  }
}

// The receiver, NOT the payer, attests to receipt. Bind the confirmation to
// the exact signed settlement event ID so a claim cannot be replaced later.
export function parseConfirmationEvent(event, group) {
  if (!isValidEnvelope(event, 9002) || !validGroup(group) ||
      !hasSingleTag(event, 'g', group.id) || !matchesGroupAddressTag(event, group)) return null
  const data = readObject(event.content, event.kind)
  if (!data || !HEX_EVENT.test(data.settlementEventId || '') ||
      !validPubkey(data.from) || !validPubkey(data.to) || data.from === data.to ||
      !group.members.includes(data.from) || !group.members.includes(data.to) ||
      event.pubkey !== data.to || !positiveSats(data.amount) ||
      !hasSingleTag(event, 'e', data.settlementEventId) ||
      !hasSingleTag(event, 'p', data.from) ||
      (data.id !== undefined && !nonemptyString(data.id, 128))) return null
  return {
    id: data.id || event.id, settlementEventId: data.settlementEventId,
    from: data.from, to: data.to, amount: data.amount,
    confirmedAt: Number.isSafeInteger(data.confirmedAt) ? data.confirmedAt : event.created_at,
    _eventId: event.id, _pubkey: event.pubkey,
  }
}
