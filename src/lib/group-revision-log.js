// Immutable, owner-signed Nostr group revision ledger (custom kind 9591).
// Input events MUST be signature-verified by the Nostr relay pool before parsing.
// Missing/ambiguous history fails closed. The relay is not a source of finality.
import { groupAddress } from './group-history.js'
import { KIND_GROUP_REVISION } from './constants.js'
import { isReadableSplitSatsSchema } from './protocol-schema.js'
import { EXPENSE_POLICY } from './expense-approvals.js'

export { KIND_GROUP_REVISION }
const HASH = /^[0-9a-f]{64}$/
const now = () => Math.floor(Date.now() / 1000)
const validMemberList = members => Array.isArray(members) && members.length >= 2 && members.length <= 100 &&
  members.every(m => typeof m === 'string' && HASH.test(m)) && new Set(members).size === members.length
const sameMembers = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')

function tagValues(tags, tag) {
  if (!Array.isArray(tags) || !tags.every(t => Array.isArray(t) && t.length >= 2 &&
    typeof t[0] === 'string' && typeof t[1] === 'string')) return null
  return tags.filter(t => t[0] === tag).map(t => t[1])
}

// Strictly validate protocol fields; do not accept identity based on content alone.
export function parseGroupRevisionEvent(event, group) {
  const address = groupAddress(group)
  if (!address || event?.kind !== KIND_GROUP_REVISION || !HASH.test(event.id || '') ||
      event.pubkey !== group.pubkey || !Number.isSafeInteger(event.created_at) ||
      event.created_at <= 0 || event.created_at > now() + 300 ||
      typeof event.content !== 'string') return null
  let content
  try { content = JSON.parse(event.content) } catch { return null }
  if (!content || typeof content !== 'object' || Array.isArray(content) ||
      !isReadableSplitSatsSchema(event.kind, content) ||
      content.groupId !== group.id || !Number.isSafeInteger(content.version) ||
      content.version < 0 || content.version > 100 ||
      !validMemberList(content.members) || !content.members.includes(group.pubkey) ||
      (content.consentPolicy !== undefined &&
        (content.version !== 0 || content.consentPolicy !== 'signed-invites-v1')) ||
      (content.expensePolicy !== undefined &&
        (content.version !== 0 || content.expensePolicy !== EXPENSE_POLICY)) ||
      ((content.exitedMember !== undefined || content.exitProofEventId !== undefined) &&
        (content.version === 0 || !HASH.test(content.exitedMember || '') ||
         !HASH.test(content.exitProofEventId || '') || content.exitedMember === group.pubkey ||
         content.members.includes(content.exitedMember)))) return null
  const prev = content.previousRevisionId
  if ((content.version === 0 && prev !== null) ||
      (content.version > 0 && !HASH.test(prev || ''))) return null
  const a = tagValues(event.tags, 'a')
  const g = tagValues(event.tags, 'g')
  const t = tagValues(event.tags, 't')
  const p = tagValues(event.tags, 'p')
  const e = tagValues(event.tags, 'e')
  const x = tagValues(event.tags, 'x')
  if (!a || a.length !== 1 || a[0] !== address ||
      !g || g.length !== 1 || g[0] !== group.id ||
      !t || t.length !== 1 || t[0] !== 'splitsats' ||
      !p || p.length !== content.members.length || new Set(p).size !== p.length ||
      !p.every(member => content.members.includes(member)) ||
      !e || (content.version === 0 ? e.length !== 0 : e.length !== 1 || e[0] !== prev) ||
      !x || (content.exitProofEventId ? x.length !== 1 || x[0] !== content.exitProofEventId : x.length !== 0)) return null
  return {
    id: event.id, groupId: group.id, pubkey: event.pubkey,
    version: content.version, previousRevisionId: prev,
    members: [...content.members], createdAt: event.created_at,
    ...(content.consentPolicy ? { consentPolicy: content.consentPolicy } : {}),
    ...(content.expensePolicy ? { expensePolicy: content.expensePolicy } : {}),
    ...(content.exitedMember ? { exitedMember: content.exitedMember,
      exitProofEventId: content.exitProofEventId } : {}),
  }
}

export function revisionTags(group, members, previousRevisionId = null) {
  const address = groupAddress(group)
  if (!address || !validMemberList(members) || !members.includes(group.pubkey) ||
      (previousRevisionId !== null && !HASH.test(previousRevisionId))) {
    throw new Error('Revisione del gruppo non valida')
  }
  return [['g', group.id], ['a', address], ['t', 'splitsats'],
    ...(previousRevisionId ? [['e', previousRevisionId]] : []),
    ...members.map(member => ['p', member])]
}

// Returns {status:'verified', chain, allMembers, removedMembers} only when a
// complete, linear chain connects the exact head referenced by the signed
// kind:30001 definition to genesis. No timestamp-based authorization.
export function verifyGroupRevisionHistory(group, candidateRevisions) {
  if (!HASH.test(group?._revisionId || '') || !groupAddress(group)) return { status: 'legacy', chain: [] }
  if (!Array.isArray(candidateRevisions)) return { status: 'pending', chain: [] }
  if (candidateRevisions.length > 500) return { status: 'conflict', chain: [] }
  const byId = new Map()
  const versions = new Map()
  for (const r of candidateRevisions) {
    if (!r || !HASH.test(r.id || '') || r.pubkey !== group.pubkey || r.groupId !== group.id ||
        !Number.isSafeInteger(r.version) || r.version < 0 || r.version > 100 ||
        !validMemberList(r.members) || !r.members.includes(group.pubkey) ||
        (r.consentPolicy != null && (r.version !== 0 || r.consentPolicy !== 'signed-invites-v1')) ||
        (r.expensePolicy != null && (r.version !== 0 || r.expensePolicy !== EXPENSE_POLICY)) ||
        ((r.exitedMember !== undefined || r.exitProofEventId !== undefined) &&
          (r.version === 0 || !HASH.test(r.exitedMember || '') ||
           !HASH.test(r.exitProofEventId || '') || r.exitedMember === group.pubkey ||
           r.members.includes(r.exitedMember))) ||
        !Number.isSafeInteger(r.createdAt) || r.createdAt <= 0 ||
        (r.version === 0 ? r.previousRevisionId !== null : !HASH.test(r.previousRevisionId || ''))) {
      return { status: 'conflict', chain: [] }
    }
    if (byId.has(r.id)) {
      if (JSON.stringify(byId.get(r.id)) !== JSON.stringify(r)) return { status: 'conflict', chain: [] }
      continue
    }
    if (versions.has(r.version) && versions.get(r.version) !== r.id) return { status: 'conflict', chain: [] }
    byId.set(r.id, r)
    versions.set(r.version, r.id)
  }
  let cursor = group._revisionId
  const reversed = []
  const visited = new Set()
  while (cursor) {
    if (visited.has(cursor) || reversed.length > 100) return { status: 'conflict', chain: [] }
    visited.add(cursor)
    const rev = byId.get(cursor)
    if (!rev) return { status: 'pending', chain: [] }
    if (reversed.length && rev.version !== reversed.at(-1).version - 1) return { status: 'conflict', chain: [] }
    reversed.push(rev)
    cursor = rev.previousRevisionId
  }
  const chain = reversed.reverse()
  if (chain.some((r, i) => i > 0 && r.createdAt < chain[i - 1].createdAt))
    return { status: 'conflict', chain: [] }
  if (!chain.length || chain[0].version !== 0 || chain.at(-1).id !== group._revisionId ||
      !sameMembers(chain.at(-1).members, group.members || [])) return { status: 'conflict', chain: [] }
  // Existing legacy revision chains predate signed exit requests. They
  // remain readable for audit; the caller MUST keep removedMembers locked
  // for financial reconciliation. New consent-policy groups strictly require
  // an exit proof in each owner-signed removal revision.
  const requireExitProof = chain[0].consentPolicy === 'signed-invites-v1'
  for (let i = 1; i < chain.length; i++) {
    const before = chain[i - 1], after = chain[i]
    const removed = before.members.filter(m => !after.members.includes(m))
    const added = after.members.filter(m => !before.members.includes(m))
    if (removed.length) {
      if (requireExitProof &&
          (removed.length !== 1 || added.length || removed[0] !== after.exitedMember ||
           !HASH.test(after.exitProofEventId || ''))) {
        return { status: 'conflict', chain: [] }
      }
      if (!requireExitProof && (after.exitedMember || after.exitProofEventId)) {
        return { status: 'conflict', chain: [] }
      }
    } else if (after.exitedMember || after.exitProofEventId) return { status: 'conflict', chain: [] }
  }
  const allMembers = [...new Set(chain.flatMap(r => r.members))]
  const removedMembers = allMembers.filter(member => !group.members.includes(member))
  return { status: 'verified', chain, allMembers, removedMembers,
    consentPolicy: chain[0].consentPolicy || null,
    expensePolicy: chain[0].expensePolicy || null }
}

// Every post-migration transaction must name a revision event it was signed
// against. Reject missing, duplicate, future and unknown revision references.
export function membersForRevisionEvent(chain, event) {
  if (!Array.isArray(chain) || !chain.length || !event || !HASH.test(event.id || '')) return null
  const r = tagValues(event.tags, 'r')
  if (!r || r.length !== 1 || !HASH.test(r[0])) return null
  const index = chain.findIndex(entry => entry.id === r[0])
  if (index < 0) return null
  const rev = chain[index]
  if (!Number.isSafeInteger(event.created_at) || event.created_at < rev.createdAt ||
      (index + 1 < chain.length && event.created_at >= chain[index + 1].createdAt)) return null
  return [...rev.members]
}
