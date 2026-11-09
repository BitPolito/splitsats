// Phase 3B-C — advisory, read-only financial namespace migration preflight.
// Neither client observations nor EOSE establish global completeness/finality.
// All real v2 financial publishing remains disabled until a later signed,
// independently reviewed cutover protocol is implemented.
import { groupAddress } from './group-history.js'
import {
  KIND_EXPENSE, KIND_SETTLEMENT, KIND_CONFIRMATION,
  KIND_EXPENSE_V2, KIND_SETTLEMENT_V2, KIND_CONFIRMATION_V2,
} from './constants.js'

const HEX = /^[0-9a-f]{64}$/
const CLIENT = /^[a-zA-Z0-9_-]{8,80}$/
const KINDS = new Set([
  KIND_EXPENSE, KIND_SETTLEMENT, KIND_CONFIRMATION,
  KIND_EXPENSE_V2, KIND_SETTLEMENT_V2, KIND_CONFIRMATION_V2,
])
const V2 = new Set([KIND_EXPENSE_V2, KIND_SETTLEMENT_V2, KIND_CONFIRMATION_V2])
const FINANCE = [
  'expenses', 'proposedExpenses', 'settlements', 'confirmations',
  '_expenseDecisions', '_cancellationDecisions',
]

export const MAX_MIGRATION_CLIENT_REPORTS = 12
export const MAX_MIGRATION_OBSERVED_EVENTS = 500

const advisory = (status, reasons = [], extra = {}) => Object.freeze({
  status, reasons: [...new Set(reasons)].sort(),
  ...extra, safeForPayments: false, completeHistory: false,
  v2WriterEnabled: false, migrationEffective: false,
})

// A Nostr event may have an author-scoped ID, but this compact report is
// OFFLINE DIAGNOSTIC DATA, NOT A SIGNED STATEMENT. Never use it to grant rights.
export function compareFinancialClientObservations(group, reports = []) {
  const address = groupAddress(group)
  if (!address || !HEX.test(group?._revisionId || '')) return advisory('blocked', ['invalid-group'])
  if (!Array.isArray(reports) || reports.length > MAX_MIGRATION_CLIENT_REPORTS)
    return advisory('blocked', ['invalid-client-reports'])
  if (reports.length < 2) return advisory('pending', ['need-independent-client-observations'], { clientCount: reports.length })

  const byClient = new Set()
  const signatures = []
  const counts = []
  for (const row of reports) {
    if (!row || !CLIENT.test(row.clientId || '') || byClient.has(row.clientId) ||
        row.address !== address || row.revisionEventId !== group._revisionId ||
        !Array.isArray(row.events) || row.events.length > MAX_MIGRATION_OBSERVED_EVENTS ||
        row.eose !== true || row.overflow !== false || row.saturated !== false ||
        row.relayConflict !== false) {
      return advisory('blocked', ['incomplete-or-invalid-client-report'])
    }
    byClient.add(row.clientId)
    const events = new Map()
    for (const e of row.events) {
      if (!e || !HEX.test(e.id || '') || !KINDS.has(e.kind))
        return advisory('blocked', ['invalid-event-reference'])
      if (events.has(e.id)) return advisory('blocked', ['duplicate-client-event-id'])
      events.set(e.id, e.kind)
    }
    if (events.size === MAX_MIGRATION_OBSERVED_EVENTS)
      return advisory('blocked', ['at-event-limit'])
    const canon = [...events].map(([id, kind]) => [id, kind]).sort((a, b) => a[0].localeCompare(b[0]))
    signatures.push(JSON.stringify(canon))
    counts.push(canon.length)
  }

  // A match establishes only the same *locally reported* IDs, not a signed
  // attestation, an upgraded peer, a complete relay history or a safe cutover.
  const equivalent = signatures.every(s => s === signatures[0])
  return advisory(equivalent ? 'matching-observed' : 'divergent',
    equivalent ? ['unsigned-observation-only'] : ['client-event-sets-diverge'],
    { clientCount: reports.length, observedEventCount: equivalent ? counts[0] : null })
}

// Pure diagnostic. Missing input is unsafe; this does not persist any approval.
export function assessFinancialMigrationPreflight(group, {
  outboxEntries = null, clientReports = [],
} = {}) {
  const reasons = []
  const address = groupAddress(group)
  if (!address || !Array.isArray(group?.members) ||
      !group.members.includes(group.pubkey) ||
      new Set(group.members).size !== group.members.length ||
      group.members.some(m => !HEX.test(m))) reasons.push('group-identity-not-verified')
  if (group?._revisionStatus !== 'verified' || !HEX.test(group?._revisionId || '') ||
      !Array.isArray(group?._revisions) || group._revisions.length !== 1 ||
      group._revisions[0]?.id !== group._revisionId ||
      group._revisions[0]?.version !== 0) reasons.push('requires-verified-genesis-only-group')
  if (group?._consentPolicy !== 'signed-invites-v1' ||
      group?._expensePolicy !== 'unanimous-expense-v1' ||
      group?._inviteStatus !== 'accepted') reasons.push('signed-consent-policy-required')
  if (group?._financialHistoryChecked !== true || group?._priorHistoryChecked !== true)
    reasons.push('observed-history-not-synced')
  if (group?._financialMigrationQuarantine || group?._financialReviewRequired ||
      group?._expenseReviewRequired || group?._historicalActivityDetected ||
      group?._priorReplayOverflow || group?._priorEvidenceOverflow)
    reasons.push('financial-safety-lock-active')
  if (FINANCE.some(key => !Array.isArray(group?.[key]) || group[key].length > 0))
    reasons.push('existing-financial-activity-requires-separate-migration')
  if (!Array.isArray(outboxEntries)) reasons.push('outbox-unavailable')
  else if (outboxEntries.length) reasons.push('pending-signed-outbox')

  const clients = compareFinancialClientObservations(group, clientReports)
  // Never call an apparently empty local ledger a candidate when *any* peer
  // reports real financial activity, including in the new namespace.
  if (Array.isArray(clientReports) && clientReports.some(row =>
      Array.isArray(row?.events) && row.events.length > 0))
    reasons.push('financial-events-observed-on-peer')
  if (clients.status === 'blocked' || clients.status === 'divergent')
    reasons.push('unverified-or-divergent-client-reports')
  const status = reasons.length ? 'blocked' : clients.status === 'matching-observed'
    ? 'candidate-only' : 'pending-peer-review'
  return advisory(status, [...reasons, ...clients.reasons,
    'requires-future-signed-unanimous-cutover', 'older-client-compatibility-unresolved'],
  { groupAddress: address, revisionEventId: group?._revisionId || null,
    clientStatus: clients.status, currentMembers: [...(group?.members || [])].sort(),
    requiredSignedParticipants: [...(group?.members || [])].sort() })
}

// Defense in depth: even if a new UI accidentally calls publishEvent() with a
// v2 kind, never ask the signer to sign and never touch the durable outbox.
export function assertFinancialV2PublishingDisabled(kind) {
  if (!V2.has(kind)) return
  const error = new Error('Migrazione finanziaria v2 non autorizzata: pubblicazione disabilitata')
  error.code = 'FINANCIAL_V2_WRITER_DISABLED'
  throw error
}
