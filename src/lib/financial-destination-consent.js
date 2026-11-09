// SplitSats 3B-G — destination-bound, NON-EXECUTING financial namespace consent format.
// This module does NOT sign, publish, create groups, transfer debts or enable v2.
// parseFinancialDestinationConsentEvent MUST receive signature-verified Nostr events.
import { groupAddress } from './group-history.js'
import { KIND_FINANCIAL_DESTINATION_CONSENT } from './constants.js'
import { buildFinancialNamespacePlan } from './financial-namespace-plan.js'
import { isReadableSplitSatsSchema } from './protocol-schema.js'

const HEX = /^[0-9a-f]{64}$/
const NOW = () => Math.floor(Date.now() / 1000)
const DOMAIN = 'splitsats-financial-destination-specific-review-v1'
const ACTION = 'review-exact-independent-financial-group-v1'
const TARGET_PREFIX = 'splitsats-v2-'
const CHOICES = new Set(['support-target-review', 'decline-target-review'])
const SIGNED_KEYS = ['action', 'choice', 'planningFingerprint', 'proposalHash',
  'sourceGroupAddress', 'sourceRevisionEventId', 'targetGroupAddress', 'version']
const MAX_ROWS = 200
const locallyBuiltDrafts = new WeakSet() // never accept a remote draft as trusted

export const FINANCIAL_DESTINATION_CONSENT_KIND = KIND_FINANCIAL_DESTINATION_CONSENT
export const FINANCIAL_DESTINATION_CONSENT_DOMAIN = DOMAIN
export const MAX_FINANCIAL_DESTINATION_CONSENTS = MAX_ROWS

const uniqueSorted = values => [...new Set(values)].sort()
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)
const base = (status, reasons = [], extra = {}) => Object.freeze({
  status, reasons: uniqueSorted(reasons), ...extra,
  activationAllowed: false, v2WriterEnabled: false, migrationEffective: false,
  safeForPayments: false, completeHistory: false, signedNewGroupCreated: false,
  balancesTransferred: false, legacyNamespaceRetired: false,
})
function shaHex(bytes) {
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}
async function sha256(text) {
  if (!globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') return null
  try { return shaHex(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))) }
  catch { return null }
}
function participants(group) {
  if (!groupAddress(group) || !HEX.test(group?._revisionId || '') ||
      group._revisionStatus !== 'verified' ||
      !Array.isArray(group._revisions) || group._revisions.length !== 1 ||
      group._revisions[0]?.id !== group._revisionId ||
      group._revisions[0]?.version !== 0 ||
      !Array.isArray(group.members) || group.members.length < 2 ||
      group.members.length > 100 || !group.members.includes(group.pubkey) ||
      group.members.some(m => !HEX.test(m)) ||
      new Set(group.members).size !== group.members.length) return null
  return [...group.members].sort()
}
function isDraft(group, draft) {
  const members = participants(group)
  if (!members || !draft || !locallyBuiltDrafts.has(draft) ||
      draft.status !== 'specific-target-review-only' || draft.version !== 1 ||
      draft.sourceGroupAddress !== groupAddress(group) ||
      draft.sourceRevisionEventId !== group._revisionId ||
      !HEX.test(draft.planningFingerprint || '') || !HEX.test(draft.proposalHash || '') ||
      !Array.isArray(draft.requiredMembers) ||
      JSON.stringify(draft.requiredMembers) !== JSON.stringify(members)) return false
  const targetId = TARGET_PREFIX + draft.planningFingerprint.slice(0, 48)
  const target = `30001:${group.pubkey}:${targetId}`
  return draft.targetGroupId === targetId && draft.targetGroupAddress === target &&
    target !== draft.sourceGroupAddress
}

// The target ID is deterministic, derives from a local-only plan fingerprint,
// and cannot be confused with a published Nostr group or activated balance.
// Planning hash binds the EXACT target, so signatures on kind:9603 CANNOT be
// reused as destination-specific kind:9604 consent.
export async function buildFinancialDestinationDraft(group, options = {}) {
  const plan = await buildFinancialNamespacePlan(group, options)
  const members = participants(group)
  if (!members || plan.status !== 'proposal-only' ||
      !HEX.test(plan.planningFingerprint || '') ||
      plan.sourceGroupAddress !== groupAddress(group) ||
      plan.sourceRevisionEventId !== group._revisionId ||
      plan.activationAllowed !== false || plan.balancesTransferred !== false ||
      plan.v2WriterEnabled !== false) {
    return base('blocked', ['source-plan-not-eligible', ...(plan.reasons || [])],
      {sourceGroupAddress: groupAddress(group), sourceRevisionEventId: group?._revisionId || null})
  }
  const targetId = TARGET_PREFIX + plan.planningFingerprint.slice(0, 48)
  const targetAddress = `30001:${group.pubkey}:${targetId}`
  if (targetAddress === plan.sourceGroupAddress || targetId === group.id)
    return base('blocked', ['source-target-collision'])
  const canonical = JSON.stringify([DOMAIN, 1, plan.sourceGroupAddress,
    group._revisionId, targetAddress, plan.planningFingerprint, members])
  const proposalHash = await sha256(canonical)
  if (!proposalHash) return base('unavailable', ['sha256-unavailable'])
  const draft = base('specific-target-review-only', [
    'target-not-created-or-verified', 'requires-fresh-destination-specific-signatures',
    'signed-review-does-not-retire-legacy', 'destination-writer-remains-disabled',
    'no-debt-import-or-payment-authorization',
  ], {
    version: 1, sourceGroupAddress: plan.sourceGroupAddress,
    sourceRevisionEventId: group._revisionId,
    planningFingerprint: plan.planningFingerprint,
    targetGroupId: targetId, targetGroupAddress: targetAddress,
    requiredMembers: members, proposalHash,
    previousReviewEventIds: [...plan.evidenceEventIds],
  })
  locallyBuiltDrafts.add(draft)
  return draft
}

// Public kind:9604 content. Only the source members can *review* the target;
// this is NOT authorization to publish any signed group definition or funds.
export function financialDestinationConsentContent(group, draft, choice) {
  if (!isDraft(group, draft) || !CHOICES.has(choice))
    throw new Error('Proposta di destinazione o scelta non valida')
  return {version: 1, action: ACTION, choice,
    sourceGroupAddress: draft.sourceGroupAddress,
    sourceRevisionEventId: draft.sourceRevisionEventId,
    targetGroupAddress: draft.targetGroupAddress,
    planningFingerprint: draft.planningFingerprint,
    proposalHash: draft.proposalHash}
}
export function financialDestinationConsentTags(group, draft) {
  if (!isDraft(group, draft)) throw new Error('Destinazione non verificata')
  return [['g', group.id], ['a', draft.sourceGroupAddress],
    ['r', draft.sourceRevisionEventId], ['z', draft.targetGroupAddress],
    ['x', draft.proposalHash], ['v', '1'], ['t', 'splitsats'],
    ...draft.requiredMembers.map(m => ['p', m])]
}
function exactly(event, tag, expected) {
  const entries = event.tags.filter(t => t[0] === tag)
  return entries.length === 1 && entries[0][1] === expected
}

export function parseFinancialDestinationConsentEvent(event, group, draft) {
  const roster = participants(group)
  if (!roster || !isDraft(group, draft) ||
      event?.kind !== KIND_FINANCIAL_DESTINATION_CONSENT ||
      !HEX.test(event?.id || '') || !roster.includes(event?.pubkey) ||
      !Number.isSafeInteger(event.created_at) || event.created_at <= 0 ||
      event.created_at > NOW() + 300 ||
      event.created_at < (group._revisions[0]?.createdAt || 0) ||
      typeof event.content !== 'string' || event.content.length > 2048 ||
      !Array.isArray(event.tags) || event.tags.length !== roster.length + 7 ||
      event.tags.some(t => !Array.isArray(t) || t.length !== 2 ||
        typeof t[0] !== 'string' || typeof t[1] !== 'string' || t[1].length > 300) ||
      !exactly(event, 'g', group.id) ||
      !exactly(event, 'a', draft.sourceGroupAddress) ||
      !exactly(event, 'r', draft.sourceRevisionEventId) ||
      !exactly(event, 'z', draft.targetGroupAddress) ||
      !exactly(event, 'x', draft.proposalHash) ||
      !exactly(event, 'v', '1') || !exactly(event, 't', 'splitsats')) return null
  const p = event.tags.filter(t => t[0] === 'p').map(t => t[1]).sort()
  if (JSON.stringify(p) !== JSON.stringify(roster)) return null
  let data
  try { data = JSON.parse(event.content) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      !isReadableSplitSatsSchema(KIND_FINANCIAL_DESTINATION_CONSENT, data) ||
      JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(SIGNED_KEYS) ||
      data.version !== 1 || data.action !== ACTION || !CHOICES.has(data.choice) ||
      data.sourceGroupAddress !== draft.sourceGroupAddress ||
      data.sourceRevisionEventId !== draft.sourceRevisionEventId ||
      data.targetGroupAddress !== draft.targetGroupAddress ||
      data.planningFingerprint !== draft.planningFingerprint ||
      data.proposalHash !== draft.proposalHash) return null
  return Object.freeze({id: event.id, member: event.pubkey, choice: data.choice,
    proposalHash: draft.proposalHash, targetGroupAddress: draft.targetGroupAddress,
    sourceRevisionEventId: draft.sourceRevisionEventId, createdAt: event.created_at})
}

// A digest is NOT proof that every historical relay was queried, nor that
// every legacy client is retired. Even unanimous 9604 signatures do not flip
// any ledger, publishing, group or wallet switch.
export function financialDestinationConsentSummary(group, draft, rows = [], audit = null, invalid = false) {
  const members = participants(group)
  if (!members || !isDraft(group, draft)) return base('unavailable', ['invalid-group-or-target'],
    {requiredMembers: [], signedMembers: [], pendingMembers: []})
  const report = (status, reasons, signed = []) => base(status, reasons, {
    requiredMembers: members, signedMembers: signed,
    pendingMembers: members.filter(m => !signed.includes(m)),
    targetGroupAddress: draft.targetGroupAddress, proposalHash: draft.proposalHash,
  })
  if (invalid || !Array.isArray(rows) || rows.length > MAX_ROWS)
    return report('conflict', ['invalid-or-over-limit-evidence'])
  const byId = new Map(), bySigner = new Map()
  for (const row of rows) {
    if (!row || !HEX.test(row.id || '') || !members.includes(row.member) ||
        !CHOICES.has(row.choice) || row.proposalHash !== draft.proposalHash ||
        row.targetGroupAddress !== draft.targetGroupAddress ||
        row.sourceRevisionEventId !== draft.sourceRevisionEventId ||
        !Number.isSafeInteger(row.createdAt) || row.createdAt <= 0 ||
        row.createdAt < (group._revisions[0]?.createdAt || 0))
      return report('conflict', ['invalid-destination-evidence'], [...bySigner.keys()].sort())
    const fingerprint = JSON.stringify([row.member, row.choice,
      row.proposalHash, row.targetGroupAddress,
      row.sourceRevisionEventId, row.createdAt])
    const old = byId.get(row.id)
    if (old) {
      if (old !== fingerprint) return report('conflict', ['same-id-different-content'])
      continue
    }
    byId.set(row.id, fingerprint)
    if (bySigner.has(row.member)) return report('conflict', ['multiple-consents-by-member'])
    bySigner.set(row.member, row)
  }
  const signed = members.filter(m => bySigner.has(m))
  if ([...bySigner.values()].some(r => r.choice === 'decline-target-review'))
    return report('declined', ['member-declined-target-review'], signed)
  if (signed.length !== members.length) return report('pending', ['missing-destination-signatures'], signed)
  if (audit?.status !== 'matching-observed')
    return report('pending-relay-audit', ['relay-observation-not-matching'], signed)
  return report('unanimous-target-review-only', [
    'new-group-creation-not-authorized', 'legacy-clients-not-retired',
    'no-financial-writes-or-debt-transfer',
  ], signed)
}
