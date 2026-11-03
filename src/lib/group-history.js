// Pure, fail-closed primitives for author-scoped Nostr group identity.
// IMPORTANT: callers must supply group revisions parsed from SIGNATURE-VERIFIED
// Nostr events. A localStorage object cannot establish a trustworthy revision.

const PUBKEY = /^[0-9a-f]{64}$/
const EVENT_ID = /^[0-9a-f]{64}$/
const NON_EMPTY_D = value => typeof value === 'string' && value.length > 0 && value.length <= 128

// NIP-33/NIP-01 addressable coordinates: kind:author:d-tag.
export function groupAddress(group) {
  if (!group || !PUBKEY.test(group.pubkey || '') || !NON_EMPTY_D(group.id)) return null
  return `30001:${group.pubkey}:${group.id}`
}

function taggedValues(event, key) {
  if (!Array.isArray(event?.tags) || !event.tags.every(tag =>
    Array.isArray(tag) && tag.length >= 2 && typeof tag[0] === 'string' && typeof tag[1] === 'string')) return null
  return event.tags.filter(tag => tag[0] === key).map(tag => tag[1])
}

// An 'a' tag, once present, is authoritative. Absence means legacy/unscoped.
// Never silently drop a malformed/duplicated 'a' tag to recover legacy mode.
export function matchesGroupAddressTag(event, group) {
  const values = taggedValues(event, 'a')
  if (values === null || values.length > 1) return false
  if (values.length === 0) return true
  const expected = groupAddress(group)
  return expected !== null && values[0] === expected
}

function validRevision(rev) {
  return groupAddress(rev) !== null && EVENT_ID.test(rev.eventId || '') &&
    Number.isSafeInteger(rev._groupCreatedAt) && rev._groupCreatedAt > 0 &&
    Array.isArray(rev.members) && rev.members.length > 0 && rev.members.length <= 100 &&
    rev.members.every(m => PUBKEY.test(m)) && new Set(rev.members).size === rev.members.length &&
    rev.members.includes(rev.pubkey)
}

function memberFingerprint(rev) { return [...rev.members].sort().join(',') }

// Resolves membership AT the event's signed timestamp; a revision published
// after an expense must not retroactively grant the sender permission. Two
// conflicting membership revisions in the same second are ambiguous and fail
// closed. Signed timestamps alone do not prove wall-clock ordering.
export function revisionAt(groupRevisions, eventTime) {
  if (!Array.isArray(groupRevisions) || !Number.isSafeInteger(eventTime) || eventTime <= 0) return null
  if (!groupRevisions.length || !groupRevisions.every(validRevision)) return null
  const address = groupAddress(groupRevisions[0])
  if (groupRevisions.some(rev => groupAddress(rev) !== address)) return null
  const eligible = groupRevisions.filter(rev => rev._groupCreatedAt <= eventTime)
  if (!eligible.length) return null
  const timestamp = Math.max(...eligible.map(rev => rev._groupCreatedAt))
  const tied = eligible.filter(rev => rev._groupCreatedAt === timestamp)
  if (new Set(tied.map(memberFingerprint)).size !== 1) return null
  return tied.sort((a, b) => a.eventId.localeCompare(b.eventId)).at(-1)
}

// Route an expense/claim/confirmation without ever merging two independent
// groups sharing the same d-tag. For COLLIDING legacy events (no 'a'), the
// only safe answer is null: the protocol never committed to one author.
export function resolveGroupAtEvent(revisions, event) {
  if (!Array.isArray(revisions) || !revisions.every(validRevision) ||
      !Number.isSafeInteger(event?.created_at) || event.created_at <= 0) return null
  const g = taggedValues(event, 'g')
  const a = taggedValues(event, 'a')
  if (g?.length !== 1 || a === null || a.length > 1) return null
  const matching = revisions.filter(rev => rev.id === g[0])
  const addresses = [...new Set(matching.map(groupAddress))]
  if (!addresses.length) return null
  let address
  if (a.length === 1) {
    if (!addresses.includes(a[0])) return null
    address = a[0]
  } else {
    if (addresses.length !== 1) return null
    address = addresses[0]
  }
  const history = matching.filter(rev => groupAddress(rev) === address)
  const revision = revisionAt(history, event.created_at)
  if (!revision) return null
  return { address, group: revision, members: [...revision.members], legacy: a.length === 0 }
}

// Do not copy unverified expenses or settlements from localStorage when
// rebuilding group state from signed relay history. An empty verified group is
// preferable to a convincing-looking but unproven balance.
export function cleanVerifiedGroupSnapshot(revision) {
  if (!validRevision(revision)) return null
  return { ...revision, members: [...revision.members], expenses: [], settlements: [], confirmations: [], _synced: false }
}
