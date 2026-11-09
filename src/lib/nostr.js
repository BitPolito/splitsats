import { verifyEvent } from 'nostr-tools'
import { nip19 } from 'nostr-tools'
import { RELAYS } from './constants'
import { RelayPool } from './relay-pool'
import { RelaySnapshotAudit } from './relay-snapshot-audit'
import { outbox, replayStoredEvents } from './outbox'
import { parseGroupEvent, parseExpenseEvent, parseSettlementEvent, parseConfirmationEvent } from './event-validation'
import { groupAddress } from './group-history'
import { KIND_GROUP_REVISION, parseGroupRevisionEvent } from './group-revision-log'
import { KIND_GROUP_INVITATION } from './constants'
import { parseInvitationDecisionEvent } from './group-invitations'
import { KIND_EXPENSE_DECISION } from './constants'
import { parseExpenseDecisionEvent } from './expense-approvals'
import { KIND_EXPENSE_CANCELLATION } from './constants'
import { parseExpenseCancellationEvent } from './expense-cancellations'
import { parseFormerMemberExitHint } from './former-member-audit'
import { KIND_HISTORICAL_ATTESTATION } from './constants'
import { parseHistoricalAttestationEvent, historicalAttestationParticipants } from './historical-attestations'
import { KIND_HISTORICAL_RECONCILIATION } from './constants'
import { parseHistoricalReconciliationEvent, reconciliationRelayReady } from './historical-reconciliation'
import { KIND_HISTORICAL_DISPOSITION_INTENT } from './constants'
import { parseHistoricalDispositionIntentEvent } from './historical-disposition-intents'
import { FinancialKindQuarantine, MIXED_FINANCIAL_KINDS, liveFinancialRelayRiskReasons } from './financial-kind-quarantine'
import { KIND_EXPENSE_V2, KIND_SETTLEMENT_V2, KIND_CONFIRMATION_V2 } from './constants'

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
  // Persist the fully signed event *before* any network I/O. On timeout the
  // exact same ID remains available for recovery after a browser restart.
  outbox.add(signed)
  await pool.publish(signed)
  // A confirmed relay ACK is enough to clear the local queue. If localStorage
  // cleanup fails, replaying this same signed ID is harmless (Nostr dedupes IDs).
  try { outbox.remove(pubkey, signed.id) } catch { /* recover via outbox later */ }
  return signed
}

// ─── Durable retry ─────────────────────────────────────────────────────────────
// No signing, no new payment: send only the exact events saved before publication.
export function pendingOutbox(pubkey) { return outbox.list(pubkey) }
export function subscribeOutbox(callback) { return outbox.subscribe(callback) }

export async function retryOutbox(pubkey) {
  if (!isValidPubkey(pubkey) || !window.nostr?.getPublicKey) {
    throw new Error('Connetti il signer Nostr prima di riprovare')
  }
  // A cached session is not proof the NIP-07 account is still the same.
  const activePubkey = await window.nostr.getPublicKey()
  if (activePubkey !== pubkey) throw new Error('Account Nostr diverso dalla sessione: impossibile ripubblicare')

  return replayStoredEvents({
    pubkey,
    activePubkey,
    store: outbox,
    publish: event => pool.publish(event),
    verify: verifyEvent,
  })
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

// An ex-member can only discover *candidate* groups through their own signed
// kind:9595 request. This does not establish active membership or access.
export function subscribeFormerMemberExitHints(viewer, onHint) {
  if (!/^[0-9a-f]{64}$/.test(viewer || '')) throw new Error('Identita non valida')
  return pool.subscribe({
    id: 'former_exit_hints_' + viewer,
    filters: [{ kinds: [9595], authors: [viewer], '#t': ['splitsats'], limit: 200 }],
    onEvent: event => {
      const hint = parseFormerMemberExitHint(event, viewer)
      if (hint) onHint(hint)
    },
  })
}

// Query the exact author-scoped, owner-signed current group definition.
// It is parsed as the owner, NEVER as a fake invitation for the ex-member.
// Authorization is checked later against the complete immutable revision log.
export function subscribeFormerMemberGroupDefinition(hint, onGroup, onEose) {
  if (!hint || !/^[0-9a-f]{64}$/.test(hint.owner || '') ||
      typeof hint.groupId !== 'string' || hint.groupId.length < 1 || hint.groupId.length > 128 ||
      hint.address !== `30001:${hint.owner}:${hint.groupId}`) {
    throw new Error('Riferimento archivio non valido')
  }
  return pool.subscribe({
    id: 'former_definition_' + hint.address,
    filters: [{ kinds: [30001], authors: [hint.owner], '#d': [hint.groupId],
      '#t': ['splitsats'], limit: 20 }],
    onEvent: event => {
      const group = parseGroupEvent(event, hint.owner, npubToHex)
      if (group && groupAddress(group) === hint.address) onGroup(group)
    },
    onEose,
  })
}

// Immutable group history: unlike kind:30001, kind:9591 is non-replaceable.
// A relay may omit events, so absence is NEVER interpreted as full history.
export function subscribeGroupRevisions(group, onRevision, onEose) {
  const address = groupAddress(group)
  if (!address) throw new Error('Indirizzo Nostr del gruppo non valido')
  return pool.subscribe({
    id: 'group_revisions_' + address,
    filters: [{ kinds: [KIND_GROUP_REVISION], authors: [group.pubkey],
      '#a': [address], '#g': [group.id], limit: 500 }],
    onEvent: event => {
      const revision = parseGroupRevisionEvent(event, group)
      if (revision) onRevision(revision)
    },
    onEose,
  })
}

// Signed membership decisions are read only after the immutable group
// revision history is verified. Nostr signatures are validated by RelayPool.
export function subscribeGroupInvitations(group, onDecision, onEose) {
  const address = groupAddress(group)
  if (!address || !group._revisionId) throw new Error('Gruppo non verificato')
  return pool.subscribe({
    id: 'group_invitations_' + address,
    filters: [{ kinds: [KIND_GROUP_INVITATION], authors: group.members.filter(pk => pk !== group.pubkey),
      '#a': [address], '#r': [group._revisionId], limit: 200 }],
    onEvent: event => {
      const decision = parseInvitationDecisionEvent(event, group)
      if (decision) onDecision(decision)
    },
    onEose,
  })
}

// Immutable signed decisions for a specific expense in an accepted group.
export function subscribeExpenseDecisions(group, onDecision, onEose) {
  const address = groupAddress(group)
  if (!address || !group._revisionId) throw new Error('Revisione del gruppo non valida')
  return pool.subscribe({
    id: 'expense_decisions_' + address,
    filters: [{ kinds: [KIND_EXPENSE_DECISION], authors: group.members,
      '#a': [address], '#g': [group.id], '#r': [group._revisionId], limit: 500 }],
    onEvent: event => {
      const decision = parseExpenseDecisionEvent(event, group)
      if (decision) onDecision(decision)
    },
    onEose,
  })
}

// Independent immutable cancellation signatures must continue to arrive
// while a disputed group's financial ledger is locked.
export function subscribeExpenseCancellations(group, onCancellation, onEose) {
  const address = groupAddress(group)
  if (!address || !group._revisionId) throw new Error('Revisione del gruppo non valida')
  return pool.subscribe({
    id: 'expense_cancellations_' + address,
    filters: [{ kinds: [KIND_EXPENSE_CANCELLATION], authors: group.members,
      '#a': [address], '#g': [group.id], '#r': [group._revisionId], limit: 500 }],
    onEvent: event => {
      const cancellation = parseExpenseCancellationEvent(event, group)
      if (cancellation) onCancellation(cancellation)
    },
    onEose,
  })
}

// Historical signed activity after a membership change requires an explicit
// financial reconciliation. The current consent protocol cannot yet replay
// old-head payment approvals against a new-head roster.
export function subscribePriorRevisionActivity(group, chain, onActivity, onEose, onAudit) {
  const address = groupAddress(group)
  const old = chain.slice(0, -1)
  const authors = [...new Set(old.flatMap(r => r.members))]
  if (!address || !old.length || !authors.length) throw new Error('Storico revisioni non valido')
  // Optional audit callbacks do NOT affect financial locking or legacy EOSE.
  const audit = typeof onAudit === 'function' ? new RelaySnapshotAudit(RELAYS) : null
  const notify = () => { if (audit) onAudit(audit.report()) }
  const unsubscribe = pool.subscribe({
    id: 'prior_finance_' + address,
    filters: [{ kinds: [KIND_GROUP_INVITATION, 9000, 9001, 9002,
      KIND_EXPENSE_V2, KIND_SETTLEMENT_V2, KIND_CONFIRMATION_V2,
      KIND_EXPENSE_DECISION, KIND_EXPENSE_CANCELLATION],
      authors, '#a': [address], '#g': [group.id],
      '#r': old.map(r => r.id), limit: 500 }],
    onEvent: onActivity,
    onEose,
    onRelayEvent: audit ? (event, relay) => {
      const row = audit.relays.get(relay)
      const wasRisk = !!(row?.late || row?.conflict || row?.overflow || row?.saturated)
      audit.record(relay, event)
      const isRisk = !!(row?.late || row?.conflict || row?.overflow || row?.saturated)
      // Avoid thousands of React/local-cache writes during initial replay.
      // Counts are published at each source EOSE; risk transitions immediately.
      if (!wasRisk && isRisk) notify()
    } : undefined,
    onRelayEose: audit ? relay => { audit.eose(relay); notify() } : undefined,
    onRelayReset: audit ? (relay, reason) => { audit.reset(relay, reason); notify() } : undefined,
  })
  if (audit) notify()
  return unsubscribe
}

// A signed statement is bound to the exact active revision; verifyEvent
// is enforced by RelayPool before the parser is called. Historical signers
// may no longer be in the current member list, but their signatures matter.
export function subscribeHistoricalAttestations(group, onAttestation) {
  const address = groupAddress(group)
  const authors = historicalAttestationParticipants(group)
  if (!address || !authors) throw new Error('Storico revisioni non verificato')
  return pool.subscribe({
    id: 'historic_attest_' + address,
    filters: [{ kinds: [KIND_HISTORICAL_ATTESTATION], authors,
      '#a': [address], '#g': [group.id], '#r': [group._revisionId], limit: 300 }],
    onEvent: event => {
      const row = parseHistoricalAttestationEvent(event, group)
      if (row) onAttestation(row)
    },
  })
}

// Independent signatures on an explicit proposed historical net vector.
// Subscription input is crypto signature-verified by RelayPool.
export function subscribeHistoricalReconciliations(group, onReconciliation, onSynced) {
  const address = groupAddress(group)
  const authors = historicalAttestationParticipants(group)
  if (!address || !authors) throw new Error('Revisioni storiche non verificate')
  // EOSE alone is insufficient. The immutable 9597 vote sets must match on
  // every configured relay epoch before another acknowledgement can be signed.
  // RelayPool calls onRelayEvent only after signature verification and before
  // cross-relay deduplication; never infer payment finality from this audit.
  const audit = new RelaySnapshotAudit(RELAYS)
  const notify = () => {
    const report = audit.report()
    onSynced?.(reconciliationRelayReady(report), report)
  }
  const stop = pool.subscribe({
    id: 'historic_recon_' + address,
    filters: [{ kinds: [KIND_HISTORICAL_RECONCILIATION], authors,
      '#a': [address], '#g': [group.id], '#r': [group._revisionId], limit: 500 }],
    onEvent: event => {
      const row = parseHistoricalReconciliationEvent(event, group)
      if (row) onReconciliation(row)
    },
    onRelayEvent: (event, relay) => {
      const before = audit.report().status
      audit.record(relay, event)
      // Most initial events require no state update; EOSE notifies below.
      // Any changed post-EOSE snapshot immediately revokes readiness.
      if (audit.report().status !== before) notify()
    },
    onRelayEose: relay => { audit.eose(relay); notify() },
    onRelayReset: (relay, reason) => { audit.reset(relay, reason); notify() },
  })
  notify()
  return stop
}

// Signed, non-effective historical disposition review statements (kind:9598).
// Observe each signed relay envelope before deduplicating across relay sources.
// EOSE agreement does NOT establish global completeness or debt discharge.
export function subscribeHistoricalDispositionIntents(group, onIntent, onAudit) {
  const address = groupAddress(group)
  const authors = historicalAttestationParticipants(group)
  if (!address || !authors) throw new Error('Catena storica non verificata')
  const audit = new RelaySnapshotAudit(RELAYS)
  const notify = () => {
    const report = audit.report()
    onAudit?.(reconciliationRelayReady(report), report)
  }
  const stop = pool.subscribe({
    id: 'historic_disposition_' + address,
    filters: [{ kinds: [KIND_HISTORICAL_DISPOSITION_INTENT], authors,
      '#a': [address], '#g': [group.id], '#r': [group._revisionId], limit: 500 }],
    onEvent: event => {
      const row = parseHistoricalDispositionIntentEvent(event, group)
      if (row) onIntent(row)
    },
    onRelayEvent: (event, relay) => {
      const before = audit.report().status
      audit.record(relay, event)
      if (audit.report().status !== before) notify()
    },
    onRelayEose: relay => { audit.eose(relay); notify() },
    onRelayReset: (relay, reason) => { audit.reset(relay, reason); notify() },
  })
  notify()
  return stop
}

// Voluntary leave requests stay retrievable by current members even after
// the former member is no longer included in the replaceable group p tags.
export function subscribeMemberExitRequests(group, parse, onRequest, onEose) {
  const address = groupAddress(group)
  if (!address || !Array.isArray(group._revisions) || !group._revisions.length) {
    throw new Error('Catena membership mancante')
  }
  const authors = [...new Set(group._revisions.flatMap(r => r.members))]
  return pool.subscribe({
    id: 'member_exits_' + address,
    filters: [{ kinds: [9595], authors, '#a': [address],
      '#r': group._revisions.map(r => r.id), limit: 500 }],
    onEvent: event => {
      const request = parse(event, group)
      if (request) onRequest(request)
    },
    onEose,
  })
}

// 3B-B: separate verified mixed-kind observer. 3B-A readers are NOT connected
// to the live ledger: any new financial kind or contradictory set is quarantined.
// Never use matched relay sets as proof that missing events do not exist.
export function subscribeFinancialKindAudit(group, onRisk) {
  const address = groupAddress(group)
  if (!address || group?._revisionStatus !== 'verified' ||
      !Array.isArray(group.members) || !group.members.length ||
      !group._revisionId) throw new Error('Revisione finanziaria non verificata')
  const guard = new FinancialKindQuarantine(group)
  const audit = new RelaySnapshotAudit(RELAYS)
  let lastAlert = ''
  const notify = () => {
    const report = guard.report()
    const relay = audit.report()
    // Live financial events can arrive AFTER the initial EOSE, often reaching
    // different relays at different times. Unlike an immutable historical
    // checkpoint, that is ordinary operation, NOT a permanent quarantine.
    const reasons = new Set([...report.reasons, ...liveFinancialRelayRiskReasons(relay)])
    if (!reasons.size) return
    const sorted = [...reasons].sort()
    const fingerprint = JSON.stringify(sorted)
    if (fingerprint !== lastAlert) {
      lastAlert = fingerprint
      onRisk?.({ ...report, status: 'quarantine', reasons: sorted,
        relayStatus: relay.status, safeForPayments: false, completeHistory: false })
    }
  }
  return pool.subscribe({
    id: 'financial_kind_audit_' + address,
    filters: [{ kinds: [...MIXED_FINANCIAL_KINDS], authors: [...new Set(group.members)],
      '#a': [address], '#g': [group.id], '#r': [group._revisionId], limit: 500 }],
    onEvent: event => { guard.observe(event); notify() },
    onRelayEvent: (event, relay) => { audit.record(relay, event); notify() },
    onRelayEose: relay => { audit.eose(relay); notify() },
    onRelayReset: (relay, reason) => { audit.reset(relay, reason); notify() },
  })
}

// ─── Expenses ─────────────────────────────────────────────────────────────────

export function subscribeExpenses(groupId, hexMembers, onExpense, onEose, ownerPubkey = null, resolveEventMembers = null, canUseEvent = null) {
  return pool.subscribe({
    id:      'expenses_' + (ownerPubkey ? `${ownerPubkey}:${groupId}` : groupId),
    filters: [{ kinds: [9000], authors: hexMembers, '#g': [groupId], limit: 500 }],
    onEvent: (event) => {
      if (canUseEvent && !canUseEvent(event)) return
      const actualMembers = resolveEventMembers ? resolveEventMembers(event) : hexMembers
      if (!actualMembers) return
      const expense = parseExpenseEvent(event, { id: groupId, pubkey: ownerPubkey, members: actualMembers })
      if (expense) onExpense({ ...expense, _signedAt: event.created_at, _membersAtRevision: actualMembers,
        _legacyUnscoped: !event.tags.some(tag => tag[0] === 'a') })
    },
    onEose,
  })
}

// ─── Settlements ──────────────────────────────────────────────────────────────

export function subscribeSettlements(groupId, hexMembers, onSettlement, onEose, ownerPubkey = null, resolveEventMembers = null, canUseEvent = null) {
  return pool.subscribe({
    id:      'settlements_' + (ownerPubkey ? `${ownerPubkey}:${groupId}` : groupId),
    filters: [{ kinds: [9001], authors: hexMembers, '#g': [groupId], limit: 200 }],
    onEvent: (event) => {
      if (canUseEvent && !canUseEvent(event)) return
      const actualMembers = resolveEventMembers ? resolveEventMembers(event) : hexMembers
      if (!actualMembers) return
      const settlement = parseSettlementEvent(event, { id: groupId, pubkey: ownerPubkey, members: actualMembers })
      if (settlement) onSettlement({ ...settlement, _membersAtRevision: actualMembers,
        _legacyUnscoped: !event.tags.some(tag => tag[0] === 'a') })
    },
    onEose,
  })
}
// ─── Recipient-signed payment confirmations ─────────────────────────────────
export function subscribeConfirmations(groupId, hexMembers, onConfirmation, onEose, ownerPubkey = null, resolveEventMembers = null, canUseEvent = null) {
  return pool.subscribe({
    id:      'confirmations_' + (ownerPubkey ? `${ownerPubkey}:${groupId}` : groupId),
    filters: [{ kinds: [9002], authors: hexMembers, '#g': [groupId], limit: 200 }],
    onEvent: event => {
      if (canUseEvent && !canUseEvent(event)) return
      const actualMembers = resolveEventMembers ? resolveEventMembers(event) : hexMembers
      if (!actualMembers) return
      const confirmation = parseConfirmationEvent(event, { id: groupId, pubkey: ownerPubkey, members: actualMembers })
      if (confirmation) onConfirmation({ ...confirmation, _membersAtRevision: actualMembers,
        _legacyUnscoped: !event.tags.some(tag => tag[0] === 'a') })
    },
    onEose,
  })
}
