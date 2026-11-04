// Phase 2E-C-B: read-only historic member discovery and authorization.
// Caller MUST supply Nostr envelopes previously signature-verified by RelayPool.
// This module does not grant active membership or permission to spend.
const HEX = /^[0-9a-f]{64}$/
const MAX_GROUP_ID = 128
const CURRENT = () => Math.floor(Date.now() / 1000)
function one(tags, name) {
  if (!Array.isArray(tags) || tags.length > 128 || !tags.every(t =>
    Array.isArray(t) && t.length >= 2 && typeof t[0] === 'string' && typeof t[1] === 'string')) return null
  const found = tags.filter(t => t[0] === name)
  return found.length === 1 ? found[0][1] : null
}

export function parseFormerMemberExitHint(event, viewer) {
  if (!HEX.test(viewer || '') || event?.kind !== 9595 || event.pubkey !== viewer ||
      !HEX.test(event.id || '') || !Number.isSafeInteger(event.created_at) ||
      event.created_at <= 0 || event.created_at > CURRENT() + 300 ||
      typeof event.content !== 'string' || event.content.length > 1024 ||
      one(event.tags, 't') !== 'splitsats') return null
  let data
  try { data = JSON.parse(event.content) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      data.action !== 'leave' || typeof data.groupId !== 'string' ||
      data.groupId.length < 1 || data.groupId.length > MAX_GROUP_ID ||
      !HEX.test(data.revisionEventId || '') ||
      one(event.tags, 'g') !== data.groupId ||
      one(event.tags, 'r') !== data.revisionEventId) return null
  const owner = one(event.tags, 'p')
  if (!HEX.test(owner || '') || owner === viewer) return null
  const address = `30001:${owner}:${data.groupId}`
  if (one(event.tags, 'a') !== address) return null
  // An exit hint is only a discovery lead, NOT proof that exit occurred.
  return { id: event.id, member: viewer, owner, groupId: data.groupId,
    address, revisionEventId: data.revisionEventId, createdAt: event.created_at }
}

// Valid only with separately verified owner-signed revision chain and
// signer-authenticated leave request (verifyMemberExitProofs == 'verified').
export function formerMemberAuditEligibility(group, viewer, hint, requests, proofStatus) {
  if (!HEX.test(viewer || '') || !group || group._revisionStatus !== 'verified' ||
      !HEX.test(group.pubkey || '') || !Array.isArray(group.members) ||
      group.members.includes(viewer) || !Array.isArray(group._revisions) ||
      group._revisions.length < 2 || group._revisions.at(-1)?.id !== group._revisionId ||
      hint?.member !== viewer || hint.owner !== group.pubkey || hint.groupId !== group.id ||
      hint.address !== `30001:${group.pubkey}:${group.id}` ||
      !HEX.test(hint.id || '') || !HEX.test(hint.revisionEventId || '') ||
      proofStatus !== 'verified' || !Array.isArray(requests)) return false
  const chain = group._revisions
  if (chain[0].consentPolicy !== 'signed-invites-v1' ||
      !chain.slice(0, -1).some(r => r.members?.includes(viewer))) return false
  // The signed hint must be the EXACT proof referenced by the later
  // owner-signed removal revision. An unfinalized request is insufficient.
  const removedBy = chain.find((r, i) => i > 0 && r.exitedMember === viewer &&
    r.exitProofEventId === hint.id && r.previousRevisionId === hint.revisionEventId)
  if (!removedBy || chain.at(-1).members.includes(viewer)) return false
  return requests.filter(r => r.id === hint.id && r.member === viewer &&
    r.action === 'leave' && r.revisionEventId === hint.revisionEventId).length === 1
}
