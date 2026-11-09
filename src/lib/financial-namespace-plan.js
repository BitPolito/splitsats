// SplitSats Phase 3B-F: deterministic, LOCAL-ONLY prospective financial
// namespace planning evidence. This is NOT a Nostr event, signed commitment,
// consent to a new group, migration, wallet instruction or payment authority.
// Never use these outputs as an input to financial state transitions.
import { groupAddress } from './group-history.js'
import { FINANCIAL_MIGRATION_REVIEW_PROPOSAL,
  financialMigrationReviewSummary } from './financial-migration-intents.js'
import { assessFinancialClientCutoverBarrier } from './financial-client-compatibility.js'

const HEX = /^[0-9a-f]{64}$/
const CLIENT = /^[a-zA-Z0-9_-]{8,80}$/
const DOMAIN = 'splitsats-independent-financial-namespace-preview-v1'
export const FINANCIAL_NAMESPACE_PLAN_VERSION = 1
export const FINANCIAL_NAMESPACE_PLAN_DOMAIN = DOMAIN
export const FINANCIAL_NAMESPACE_STRATEGIES = Object.freeze([
  Object.freeze({ id: 'in-place-kind-switch', status: 'forbidden',
    reason: 'legacy-clients-cannot-observe-v2' }),
  Object.freeze({ id: 'independent-new-group', status: 'future-proposal-only',
    reason: 'requires-new-signed-group-and-explicit-new-consents' }),
])

function nonbinding(status, reasons = [], extra = {}) {
  return Object.freeze({
    version: FINANCIAL_NAMESPACE_PLAN_VERSION,
    status, reasons: [...new Set(reasons)].sort(),
    sourceGroupAddress: null, sourceRevisionEventId: null,
    planningFingerprint: null, evidenceEventIds: [],
    proposedNewGroupAddress: null, proposedNewGroupId: null,
    ...extra,
    // These NEVER become true on ANY code path, including matching previews.
    activationAllowed: false, migrationEffective: false,
    v2WriterEnabled: false, safeForPayments: false,
    completeHistory: false, signedNewGroupCreated: false,
    balancesTransferred: false, legacyNamespaceRetired: false,
  })
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

// This is a planning fingerprint, NOT a commitment to a target group address.
// Kind 9603 signatures reviewed a different proposal; they cannot be reused as
// agreement to leave an old group or to establish a new financial namespace.
export async function buildFinancialNamespacePlan(group, {
  outboxEntries = null, clientReports = [], observedOperations = [],
} = {}) {
  const address = groupAddress(group)
  const head = group?._revisionId
  const review = financialMigrationReviewSummary(group,
    group?._migrationReviewRows || [], group?._migrationReviewAudit,
    !!group?._migrationReviewConflict)
  const barrier = assessFinancialClientCutoverBarrier(group,
    { outboxEntries, clientReports, observedOperations })

  const reasons = [...barrier.reasons,
    'new-independent-group-consent-not-signed',
    'old-clients-can-still-write-legacy-group',
    'no-legacy-balance-import-allowed',
    'no-relay-completeness-proof',
  ]
  if (!address || !HEX.test(head || '') || review.status !== 'unanimous-review-observed' ||
      barrier.status !== 'review-only' || !Array.isArray(outboxEntries) || outboxEntries.length ||
      !Array.isArray(group?.members) || group.members.length < 2 ||
      group.members.length > 100 || group.members.some(pk => !HEX.test(pk))) {
    return nonbinding('blocked', [...reasons, 'source-not-ready-for-plan'],
      { sourceGroupAddress: address || null, sourceRevisionEventId: HEX.test(head || '') ? head : null,
        reviewStatus: review.status, compatibilityStatus: barrier.status })
  }

  const roster = [...group.members].sort()
  const rows = group._migrationReviewRows
  // Revalidate the exact signed event IDs, unique signers and proposal before
  // binding them into a deterministic fingerprint; never trust a JSON summary.
  if (!Array.isArray(rows) || rows.length !== roster.length ||
      rows.some(row => !row || !HEX.test(row.id || '') ||
        row.choice !== 'support-review' ||
        row.revisionEventId !== head ||
        row.proposalId !== FINANCIAL_MIGRATION_REVIEW_PROPOSAL) ||
      new Set(rows.map(row => row.id)).size !== roster.length ||
      new Set(rows.map(row => row.member)).size !== roster.length ||
      rows.some(row => !roster.includes(row.member))) {
    return nonbinding('blocked', [...reasons, 'invalid-signature-references'],
      { sourceGroupAddress: address, sourceRevisionEventId: head,
        reviewStatus: review.status, compatibilityStatus: barrier.status })
  }
  const evidence = rows.map(row => [row.member, row.id])
    .sort((a, b) => a[0].localeCompare(b[0]))
  // No transaction amounts, payment addresses or private preimages here.
  const canonical = JSON.stringify([DOMAIN, 1, address, head, roster,
    FINANCIAL_MIGRATION_REVIEW_PROPOSAL, evidence])
  if (!globalThis.crypto?.subtle || typeof TextEncoder === 'undefined') {
    return nonbinding('unavailable', [...reasons, 'sha256-not-available'],
      { sourceGroupAddress: address, sourceRevisionEventId: head,
        reviewStatus: review.status, compatibilityStatus: barrier.status })
  }
  try {
    const digest = hex(await globalThis.crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(canonical)))
    return nonbinding('proposal-only', reasons, {
      sourceGroupAddress: address, sourceRevisionEventId: head,
      planningFingerprint: digest,
      evidenceEventIds: evidence.map(([, id]) => id),
      reviewedMembers: roster,
      reviewStatus: review.status, compatibilityStatus: barrier.status,
      strategy: 'independent-new-group',
    })
  } catch {
    return nonbinding('unavailable', [...reasons, 'sha256-failed'],
      { sourceGroupAddress: address, sourceRevisionEventId: head,
        reviewStatus: review.status, compatibilityStatus: barrier.status })
  }
}

// Compare independently CALCULATED previews only for troubleshooting. Client
// identifiers and fingerprints supplied here are NOT authenticated. Even a
// matching result cannot prove all devices updated or unlock a new writer.
export function compareFinancialNamespacePlans(group, reports = []) {
  const address = groupAddress(group)
  const head = group?._revisionId
  if (!address || !HEX.test(head || '') || !Array.isArray(reports) ||
      reports.length > 12) return nonbinding('invalid', ['invalid-group-or-reports'])
  if (reports.length < 2) return nonbinding('pending', ['need-two-local-previews'],
    { sourceGroupAddress: address, sourceRevisionEventId: head })
  const ids = new Set()
  for (const row of reports) {
    if (!row || !CLIENT.test(row.clientId || '') || ids.has(row.clientId) ||
        row.version !== 1 || row.status !== 'proposal-only' ||
        row.sourceGroupAddress !== address || row.sourceRevisionEventId !== head ||
        !HEX.test(row.planningFingerprint || '') ||
        row.activationAllowed !== false || row.v2WriterEnabled !== false ||
        row.migrationEffective !== false) {
      return nonbinding('invalid', ['invalid-or-stale-preview'],
        { sourceGroupAddress: address, sourceRevisionEventId: head })
    }
    ids.add(row.clientId)
  }
  const match = reports.every(row => row.planningFingerprint === reports[0].planningFingerprint)
  return nonbinding(match ? 'matching-claimed' : 'divergent',
    [match ? 'unauthenticated-local-preview-match' : 'preview-fingerprints-diverge',
      'not-client-upgrade-or-relay-completeness-evidence'],
    { sourceGroupAddress: address, sourceRevisionEventId: head,
      comparedClientCount: reports.length })
}
