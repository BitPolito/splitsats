// SplitSats 3B-E: conservative, read-only protocol visibility and cutover barrier.
// This module NEVER authorizes new kinds, a legacy debt write-off or Lightning.
// Its samples and peer reports are untrusted, unsigned diagnostics; do not use
// them to claim relay completeness, signer identity or client upgrade status.
import { groupAddress } from './group-history.js'
import {
  KIND_EXPENSE, KIND_SETTLEMENT, KIND_CONFIRMATION,
  KIND_EXPENSE_V2, KIND_SETTLEMENT_V2, KIND_CONFIRMATION_V2,
} from './constants.js'
import { assessFinancialMigrationPreflight } from './financial-migration-preflight.js'
import { financialMigrationReviewSummary } from './financial-migration-intents.js'

const HEX = /^[0-9a-f]{64}$/
const MAX_SAMPLE = 500
const FAMILY = new Map([
  [KIND_EXPENSE, 'expense'], [KIND_EXPENSE_V2, 'expense'],
  [KIND_SETTLEMENT, 'settlement'], [KIND_SETTLEMENT_V2, 'settlement'],
  [KIND_CONFIRMATION, 'confirmation'], [KIND_CONFIRMATION_V2, 'confirmation'],
])
const LEGACY = new Set([KIND_EXPENSE, KIND_SETTLEMENT, KIND_CONFIRMATION])
const V2 = new Set([KIND_EXPENSE_V2, KIND_SETTLEMENT_V2, KIND_CONFIRMATION_V2])
const reasons = list => [...new Set(list)].sort()
const invariant = (value) => Object.freeze({ ...value,
  activationAllowed: false, v2WriterEnabled: false, migrationEffective: false,
  safeForPayments: false, completeHistory: false,
})

// The legacy client reads ONLY 9000-9002. A 3B-A+ client understands v2 parser
// shapes but MUST NOT feed them to the ledger while the writer is disabled.
export const FINANCIAL_CLIENT_KIND_MATRIX = Object.freeze([
  ['expense', KIND_EXPENSE, KIND_EXPENSE_V2],
  ['settlement-claim', KIND_SETTLEMENT, KIND_SETTLEMENT_V2],
  ['recipient-confirmation', KIND_CONFIRMATION, KIND_CONFIRMATION_V2],
].map(([family, legacyKind, v2Kind]) => Object.freeze({
  family, legacyKind, v2Kind, oldClientReadsLegacy: true,
  oldClientReadsV2: false, newClientReadsLegacy: true,
  newClientV2Mode: 'quarantine-only',
})))

function invalidVisibility(reason) {
  return invariant({ status: 'invalid-sample', reasons: [reason],
    observedCount: 0, legacyVisibleIds: [], v2OnlyIds: [],
    diagnosticsOnlyIds: [], crossKindDuplicateIds: [] })
}

// Accept only bounded immutable identifiers as untrusted *diagnostic inputs*.
// The caller MUST NOT reconstruct balances or infer absence from this sample.
export function compareFinancialNamespaceVisibility(group, observations = []) {
  const address = groupAddress(group)
  if (!address || !HEX.test(group?._revisionId || '') ||
      !Array.isArray(group?.members) || !group.members.includes(group.pubkey) ||
      new Set(group.members).size !== group.members.length ||
      group.members.some(pk => !HEX.test(pk))) return invalidVisibility('invalid-group')
  if (!Array.isArray(observations) || observations.length >= MAX_SAMPLE)
    return invalidVisibility('invalid-or-at-limit-sample')
  const byEvent = new Map(), byOperation = new Map()
  const legacyIds = [], v2Ids = [], duplicates = []
  for (const row of observations) {
    if (!row || !HEX.test(row.id || '') || !HEX.test(row.pubkey || '') ||
        !group.members.includes(row.pubkey) || !FAMILY.has(row.kind) ||
        typeof row.logicalId !== 'string' || !row.logicalId.length ||
        row.logicalId.length > 128 || !/^[\x21-\x7e]+$/.test(row.logicalId) ||
        row.address !== address || row.revisionEventId !== group._revisionId)
      return invalidVisibility('invalid-or-cross-group-event')
    const identity = JSON.stringify([row.kind, row.pubkey, row.logicalId,
      row.address, row.revisionEventId])
    if (byEvent.has(row.id)) {
      if (byEvent.get(row.id) !== identity) return invalidVisibility('same-id-different-event')
      continue // Multiple relay deliveries of one immutable ID are harmless.
    }
    byEvent.set(row.id, identity)
    const key = JSON.stringify([FAMILY.get(row.kind), row.pubkey, row.logicalId])
    const previous = byOperation.get(key)
    if (previous && previous.id !== row.id) duplicates.push(previous.id, row.id)
    else byOperation.set(key, { id: row.id, kind: row.kind })
    if (LEGACY.has(row.kind)) legacyIds.push(row.id)
    else if (V2.has(row.kind)) v2Ids.push(row.id)
  }
  const duplicateIds = [...new Set(duplicates)].sort()
  const legacyVisibleIds = [...new Set(legacyIds)].sort()
  const v2OnlyIds = [...new Set(v2Ids)].sort()
  const status = duplicateIds.length ? 'conflicting-operations' :
    v2OnlyIds.length ? 'legacy-client-blind-to-v2' :
      legacyVisibleIds.length ? 'legacy-only-observed' : 'empty-untrusted-sample'
  const flags = []
  if (duplicateIds.length) flags.push('duplicate-logical-financial-operation')
  if (v2OnlyIds.length) flags.push('older-clients-ignore-v2-kind')
  if (!observations.length) flags.push('absence-cannot-be-proven')
  return invariant({ status, reasons: reasons(flags), observedCount: byEvent.size,
    legacyVisibleIds, v2OnlyIds, diagnosticsOnlyIds: v2OnlyIds,
    crossKindDuplicateIds: duplicateIds.slice(0, 16) })
}

// Review events are signed preferences, not release/cutover consent. Any old
// application that still writes legacy events can diverge from a v2-only client.
// No finite set of capability reports can prove all installed devices upgraded.
export function assessFinancialClientCutoverBarrier(group, {
  outboxEntries = null, clientReports = [], observedOperations = [],
} = {}) {
  const preflight = assessFinancialMigrationPreflight(group, { outboxEntries, clientReports })
  const review = financialMigrationReviewSummary(group,
    group?._migrationReviewRows || [], group?._migrationReviewAudit,
    !!group?._migrationReviewConflict)
  const visibility = compareFinancialNamespaceVisibility(group, observedOperations)
  // Even one claimed peer report is untrusted; reject obvious cross-group or
  // stale-head data BEFORE any preflight summary treats it as merely pending.
  const badPeerReport = !Array.isArray(clientReports) || clientReports.some(row =>
    !row || typeof row !== 'object' || row.address !== groupAddress(group) ||
    row.revisionEventId !== group?._revisionId ||
    typeof row.clientId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(row.clientId))
  const blocker = badPeerReport || preflight.status === 'blocked' ||
    visibility.status === 'invalid-sample' ||
    visibility.status === 'conflicting-operations' ||
    visibility.status === 'legacy-client-blind-to-v2' ||
    ['unavailable', 'conflict', 'declined'].includes(review.status)
  const status = blocker ? 'blocked' :
    review.status === 'unanimous-review-observed' ? 'review-only' : 'pending-review'
  const flags = [
    'in-place-legacy-v2-cutover-unsafe',
    'old-client-retirement-not-verifiable',
    'signed-review-is-not-migration-authorization',
    ...preflight.reasons,
    ...visibility.reasons,
  ]
  if (badPeerReport) flags.push('invalid-or-stale-peer-report')
  if (review.status !== 'unanimous-review-observed') flags.push('migration-review-not-unanimous')
  if (review.status === 'declined') flags.push('participant-declined-migration-review')
  if (review.status === 'conflict') flags.push('migration-review-conflict')
  return invariant({ status, reasons: reasons(flags),
    preflightStatus: preflight.status, reviewStatus: review.status,
    sampleStatus: visibility.status, sampleEventCount: visibility.observedCount,
    compatibility: FINANCIAL_CLIENT_KIND_MATRIX,
  })
}
