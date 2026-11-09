// Phase 3A: an explicit read-compatibility contract for already signed events.
// This registry is NOT an event migration, authorization decision, or wallet gate.
// Call it after verifying the Nostr envelope signature and BEFORE interpreting
// application content. A signature must never be rewritten to add a version.

import {
  KIND_GROUP, KIND_EXPENSE, KIND_SETTLEMENT, KIND_CONFIRMATION,
  KIND_GROUP_REVISION, KIND_GROUP_INVITATION, KIND_EXPENSE_DECISION,
  KIND_EXPENSE_CANCELLATION, KIND_MEMBER_EXIT,
  KIND_HISTORICAL_ATTESTATION, KIND_HISTORICAL_RECONCILIATION,
  KIND_HISTORICAL_DISPOSITION_INTENT,
} from './constants.js'

export const SPLITSATS_SCHEMA_VERSION = 1

const entry = (kind, name, payloadVersion) => Object.freeze({kind, name, payloadVersion})

// `version` has TWO pre-existing meanings and must not be reused to indicate
// a new wire schema. 9591: zero-based membership revision counter. 9596-9598:
// strictly checked action payload version (1). Others: no version contract.
// Separate `schemaVersion` is reserved for a later *compatible* wire migration.
export const SPLITSATS_PROTOCOL_KINDS = Object.freeze([
  entry(KIND_GROUP, 'group-definition', 'none'),
  entry(KIND_EXPENSE, 'expense', 'none'),
  entry(KIND_SETTLEMENT, 'settlement-claim', 'none'),
  entry(KIND_CONFIRMATION, 'recipient-confirmation', 'none'),
  entry(KIND_GROUP_REVISION, 'membership-revision', 'revision-counter'),
  entry(KIND_GROUP_INVITATION, 'invitation-decision', 'none'),
  entry(KIND_EXPENSE_DECISION, 'expense-decision', 'none'),
  entry(KIND_EXPENSE_CANCELLATION, 'expense-cancellation', 'none'),
  entry(KIND_MEMBER_EXIT, 'member-exit', 'none'),
  entry(KIND_HISTORICAL_ATTESTATION, 'historical-attestation', 'action-v1'),
  entry(KIND_HISTORICAL_RECONCILIATION, 'historical-reconciliation', 'action-v1'),
  entry(KIND_HISTORICAL_DISPOSITION_INTENT, 'historical-disposition-intent', 'action-v1'),
])

const byKind = new Map(SPLITSATS_PROTOCOL_KINDS.map(info => [info.kind, info]))
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const permitted = new Set(['legacy', 'schema-v1', 'native-v1'])
const result = (status, kind, reason = null) => Object.freeze({status, kind, reason, readable: permitted.has(status)})

// This is intentionally only a *version admission* test. Individual parsers
// remain authoritative for exact tags, group scoping, member authorization,
// numeric satoshi limits, action semantics and signature-verified event IDs.
export function inspectSplitSatsSchema(kind, content) {
  const spec = byKind.get(kind)
  if (!spec) return result('not-app-kind', kind, 'kind-not-in-splitsats-registry')
  if (content === null || typeof content !== 'object' || Array.isArray(content))
    return result('invalid-content', kind, 'content-not-object')

  // Never silently interpret a different schema namespace as an old event.
  if (own(content, 'protocolVersion')) return result('unsupported-schema', kind, 'ambiguous-version-field')
  if (own(content, 'schemaVersion')) {
    // 9596/9597/9598 have exact signed key sets; altering them would change
    // the meaning of the already acknowledged hash. Reserve new kinds instead.
    if (spec.payloadVersion === 'action-v1')
      return result('unsupported-schema', kind, 'immutable-action-format')
    if (content.schemaVersion !== SPLITSATS_SCHEMA_VERSION)
      return result('unsupported-schema', kind, 'unknown-schema-version')
    return result('schema-v1', kind)
  }
  if (spec.payloadVersion === 'action-v1') {
    return content.version === 1 ? result('native-v1', kind)
      : result('unsupported-schema', kind, 'unknown-action-version')
  }
  // `version` on 9591 is a signed revision *sequence*, not a schema version.
  // The owner-signed revision parser checks the exact range and chain.
  return result('legacy', kind)
}

export function isReadableSplitSatsSchema(kind, content) {
  return inspectSplitSatsSchema(kind, content).readable
}
