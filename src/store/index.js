import { create } from 'zustand'
import { saveGroups, loadProfiles, saveProfiles, loadPubkey, savePubkey, clearAll, clearPubkey } from '../lib/storage'
import { verifyCachedSigner } from '../lib/session-identity'
import { publishEvent, fetchProfile, fetchGroups, subscribeGroupRevisions, subscribeGroupInvitations, subscribeExpenseDecisions, subscribeExpenseCancellations, subscribePriorRevisionActivity, subscribeMemberExitRequests, subscribeHistoricalAttestations, subscribeHistoricalReconciliations, pendingOutbox, subscribeExpenses, subscribeSettlements, subscribeConfirmations, pool, npubToHex } from '../lib/nostr'
import { KIND_GROUP, KIND_EXPENSE, KIND_SETTLEMENT, KIND_CONFIRMATION, KIND_GROUP_REVISION, KIND_GROUP_INVITATION, KIND_EXPENSE_DECISION, KIND_EXPENSE_CANCELLATION, KIND_MEMBER_EXIT, KIND_HISTORICAL_ATTESTATION, KIND_HISTORICAL_RECONCILIATION } from '../lib/constants'
import { validPubkey } from '../lib/event-validation'
import { groupAddress } from '../lib/group-history'
import { parseGroupRevisionEvent, revisionTags, verifyGroupRevisionHistory, membersForRevisionEvent } from '../lib/group-revision-log'
import { findGroupByRef, mergeVerifiedGroup, mayApplyGroupTransaction } from '../lib/group-state'
import { releaseConfirmedPaymentAttempt } from '../lib/payment-attempts'
import { isConfirmedSettlement } from '../lib/settlement-status'
import { CONSENT_POLICY, invitationTags, parseInvitationDecisionEvent, invitationSummary, invitationReceiptTags, hasInvitationReceipts } from '../lib/group-invitations'
import { EXPENSE_POLICY, expenseDecisionTags, parseExpenseDecisionEvent, expenseApprovalSummary, reconcileExpenseApprovals } from '../lib/expense-approvals'
import { assertCanAddGroupMember } from '../lib/member-additions'
import { canResumeAfterPriorHistory } from '../lib/prior-history-gate'
import { priorFinancialEvidence, appendPriorEvidence } from '../lib/prior-financial-evidence'
import { appendHistoricalReplayEvent, replayHistoricalFinancialEvents } from '../lib/historical-financial-replay'
import { buildHistoricalAttestationSnapshot, parseHistoricalAttestationEvent, historicalAttestationTags, historicalAttestationSummary, MAX_HISTORICAL_ATTESTATIONS } from '../lib/historical-attestations'
import {
  buildHistoricalReconciliationCheckpoint, parseHistoricalReconciliationEvent,
  historicalReconciliationTags, historicalReconciliationSummary,
  MAX_HISTORICAL_RECONCILIATIONS,
} from '../lib/historical-reconciliation'
import { memberExitTags, parseMemberExitRequestEvent, verifyMemberExitProofs, assertCanRequestExit, assertCanFinalizeExit } from '../lib/member-exits'
import { expenseCancellationTags, parseExpenseCancellationEvent, expenseCancellationSummary } from '../lib/expense-cancellations'

const randId = () => crypto.randomUUID()
const now    = () => Math.floor(Date.now() / 1000)

const activeSubs = {}
const subscribedMemberKeys = {}
const inFlightReconciliations = new Set()
let currentSessionPubkey = null

function stopActiveSubscriptions() {
  Object.values(activeSubs).forEach(unsub => { try { unsub() } catch {} })
  Object.keys(activeSubs).forEach(key => delete activeSubs[key])
  Object.keys(subscribedMemberKeys).forEach(key => delete subscribedMemberKeys[key])
  currentSessionPubkey = null
}

export const useStore = create((set, get) => ({
  pubkey:      null, // cached key is untrusted until checked against NIP-07
  loading:     false,
  error:       null,
  groups:      [],
  profiles:    {},
  relayStatus: 0,
  toast:       null,

  getGroup: (ref) => findGroupByRef(get().groups, ref),

  // ─── AUTH ──────────────────────────────────────────────────────────────────

  restoreSession: async () => {
    if (get().pubkey) return
    const cached = loadPubkey()
    if (!cached) return
    const active = await verifyCachedSigner(cached, typeof window !== 'undefined' && window.nostr)
    // A user might have logged in manually while the signer prompt was open.
    if (get().pubkey) return
    // Cached group balances are untrusted. Reconstruct them from signed relay events.
    if (active) set({ pubkey: active, groups: [], profiles: loadProfiles(active) })
    else clearPubkey()
  },

  login: async () => {
    set({ loading: true, error: null })
    try {
      // NIP-07 always returns hex pubkey
      const pubkey = await window.nostr.getPublicKey()
      // Read/migrate legacy cache under its original owner BEFORE switching the hint.
      // Do not hydrate cached financial state before verifying relay signatures.
      const profiles = loadProfiles(pubkey)
      stopActiveSubscriptions()
      savePubkey(pubkey)
      set({ pubkey, groups: [], profiles, loading: false })
    } catch (e) {
      set({ error: e.message, loading: false })
    }
  },

  logout: () => {
    stopActiveSubscriptions()
    clearAll(get().pubkey)
    set({ pubkey: null, groups: [], profiles: {}, error: null })
  },

  // ─── SESSION INIT ──────────────────────────────────────────────────────────

  initSession: (pubkey) => {
    // React StrictMode may invoke the effect twice; never open duplicate subscriptions.
    if (!pubkey || currentSessionPubkey === pubkey) return
    stopActiveSubscriptions()
    currentSessionPubkey = pubkey
    get().fetchAndCacheProfile(pubkey)

    // Relay status
    const interval = setInterval(() => set({ relayStatus: pool.connectedCount }), 4000)
    set({ relayStatus: pool.connectedCount })
    activeSubs['_status'] = () => clearInterval(interval)

    // No localStorage group snapshots are trusted on startup. Relay-signed
    // definitions below create the subscriptions on each fresh session.

    // Relay order is not canonical: groups are NIP-33 addressable events.
    activeSubs['_groups'] = fetchGroups(
      pubkey,
      (groupData) => {
        if (currentSessionPubkey !== pubkey) return
        const ref = groupAddress(groupData)
        if (!ref) return
        const nextGroups = mergeVerifiedGroup(get().groups, groupData)
        if (nextGroups === get().groups) return
        set(() => {
          saveGroups(pubkey, nextGroups)
          return { groups: nextGroups }
        })
        // Preserve an immutable, signed chain for ledger-enabled groups.
        // Historical members are fetched only after the complete head->genesis
        // chain has been reconstructed; current-member snapshots are not enough.
        const live = get().getGroup(ref)
        if (live?._revisionId) {
          // If a new metadata revision points to another immutable head, stop
          // all old transaction listeners before accepting any more balances.
          for (const type of ['exp_', 'set_', 'conf_']) {
            activeSubs[type + ref]?.()
            delete activeSubs[type + ref]
          }
          delete subscribedMemberKeys[ref]
          activeSubs['inv_' + ref]?.()
          delete activeSubs['inv_' + ref]
          activeSubs['approval_' + ref]?.()
          delete activeSubs['approval_' + ref]
          activeSubs['cancel_' + ref]?.()
          delete activeSubs['cancel_' + ref]
          activeSubs['prior_' + ref]?.()
          delete activeSubs['prior_' + ref]
          activeSubs['leave_' + ref]?.()
          delete activeSubs['leave_' + ref]
          activeSubs['historic_attest_' + ref]?.()
          delete activeSubs['historic_attest_' + ref]
          activeSubs['historic_recon_' + ref]?.()
          delete activeSubs['historic_recon_' + ref]
          activeSubs['rev_' + ref]?.()
          const head = live._revisionId
          const received = new Map()
          const onRevision = revision => {
            if (currentSessionPubkey !== pubkey || get().getGroup(ref)?._revisionId !== head) return
            received.set(revision.id, revision)
            const current = get().getGroup(ref)
            const result = verifyGroupRevisionHistory(current, [...received.values()])
            if (result.status === 'pending') return
            if (result.status === 'verified') {
              const alreadyVerified = current._revisionStatus === 'verified' &&
                current._revisions?.length === result.chain.length &&
                current._revisions.at(-1)?.id === head
              if (!alreadyVerified) {
                set(s => {
                  const groups = s.groups.map(g => groupAddress(g) === ref
                    ? { ...g, _revisions: result.chain, _revisionStatus: 'verified',
                      _financialReviewRequired: result.chain.length > 1 || result.removedMembers.length > 0,
                      _priorHistoryChecked: result.chain.length <= 1,
                      _priorFinancialEvidence: [], _priorEvidenceOverflow: false,
                      _priorReplayEvents: [], _priorReplayOverflow: false,
                      _priorRelayAudit: null,
                      _historicalSnapshot: null, _historicalAttestations: [],
                      _historicalAttestationConflict: false,
                      _reconciliationCheckpoint: null, _reconciliationRows: [],
                      _reconciliationConflict: false, _reconciliationDecisionsChecked: false,
                      _reconciliationDecisionAudit: null,
                      _memberExitRequests: [], _memberExitStatus: result.removedMembers.length ? 'pending' : 'none',
                      _historicalActivityDetected: false,
                      _consentPolicy: result.consentPolicy, _inviteDecisions: [],
                      _inviteStatus: result.consentPolicy ? 'pending' : 'legacy',
                      _expensePolicy: result.expensePolicy, proposedExpenses: [],
                      _expenseDecisions: [], _cancellationDecisions: [], _expenseReviewRequired: false,
                      _financialHistoryChecked: false,
                      expenses: [], settlements: [], confirmations: [] }
                    : g)
                  saveGroups(pubkey, groups)
                  return { groups }
                })
              }
              // Restore old-head exit evidence regardless of whether the
              // removed member still appears in the current group definition.
              get().watchMemberExits(ref)
              get().watchHistoricalAttestations(ref)
              get().watchHistoricalReconciliations(ref)
              // Even a seemingly empty current ledger may hide historical
              // transactions: watch old heads independently of new consent.
              if (result.chain.length > 1 && !activeSubs['prior_' + ref]) {
                activeSubs['prior_' + ref] = subscribePriorRevisionActivity(current, result.chain, event => get().recordPriorFinancialEvidence(ref, head, event), () => get().completePriorHistory(ref, head), report => get().observePriorRelayAudit(ref, head, report))
              }
              if (!result.removedMembers.length) {
                if (result.consentPolicy === CONSENT_POLICY) get().watchGroupInvitations(ref)
                else get().subscribeGroup(ref, result.allMembers)
              }
            } else {
              for (const type of ['exp_', 'set_', 'conf_']) {
                activeSubs[type + ref]?.()
                delete activeSubs[type + ref]
              }
              delete subscribedMemberKeys[ref]
              set(s => {
                const groups = s.groups.map(g => groupAddress(g) === ref
                  ? { ...g, _revisionStatus: 'conflict', _revisions: [],
                    expenses: [], settlements: [], confirmations: [] }
                  : g)
                saveGroups(pubkey, groups)
                return { groups }
              })
            }
          }
          activeSubs['rev_' + ref] = subscribeGroupRevisions(live, onRevision, () => {
            if (currentSessionPubkey !== pubkey) return
            set(s => {
              const groups = s.groups.map(g => groupAddress(g) === ref && g._revisionId === head &&
                g._revisionStatus === 'pending' ? { ...g, _revisionStatus: 'incomplete' } : g)
              return { groups }
            })
          })
        } else {
          // Legacy groups have no signed revision history; warn before use.
          get().subscribeGroup(ref, live?.members || groupData.members)
        }
        groupData.members.forEach(m => get().fetchAndCacheProfile(m))
      },
      () => {
        if (currentSessionPubkey !== pubkey) return
        set(s => {
          const groups = s.groups.map(g => ({ ...g, _synced: true }))
          saveGroups(get().pubkey, groups)
          return { groups }
        })
      }
    )
  },

  // ─── PHASE 2E-C-A: SIGNED HISTORICAL SNAPSHOT ATTESTATIONS ────────────────
  watchHistoricalAttestations: (ref) => {
    const group = get().getGroup(ref), account = get().pubkey
    if (!account || !group?.members?.includes(account) ||
        group._revisionStatus !== 'verified' ||
        !Array.isArray(group._revisions) || group._revisions.length < 2 ||
        activeSubs['historic_attest_' + ref]) return
    const head = group._revisionId
    activeSubs['historic_attest_' + ref] = subscribeHistoricalAttestations(group, row => {
      if (get().pubkey !== account || currentSessionPubkey !== account ||
          get().getGroup(ref)?._revisionId !== head) return
      get().applyHistoricalAttestation(ref, row)
    })
  },

  watchHistoricalReconciliations: (ref) => {
    const group = get().getGroup(ref), account = get().pubkey
    if (!account || !group?.members?.includes(account) ||
        group._revisionStatus !== 'verified' ||
        !Array.isArray(group._revisions) || group._revisions.length < 2 ||
        activeSubs['historic_recon_' + ref]) return
    const head = group._revisionId
    activeSubs['historic_recon_' + ref] = subscribeHistoricalReconciliations(group, row => {
      if (get().pubkey !== account || currentSessionPubkey !== account ||
          get().getGroup(ref)?._revisionId !== head) return
      get().applyHistoricalReconciliation(ref, row)
    }, (ready, decisionAudit) => {
      if (get().pubkey !== account || currentSessionPubkey !== account ||
          get().getGroup(ref)?._revisionId !== head) return
      set(s => ({ groups: s.groups.map(g => groupAddress(g) === ref && g._revisionId === head
        ? { ...g, _reconciliationDecisionsChecked: ready,
            _reconciliationDecisionAudit: decisionAudit,
            ...(ready ? {} : { _reconciliationCheckpoint: null }) } : g) }))
      if (ready) void get().refreshReconciliationCheckpoint(ref)
    })
  },

  applyHistoricalReconciliation: (ref, row) => {
    const group = get().getGroup(ref), account = get().pubkey
    if (!account || !group || row?.revisionEventId !== group._revisionId) return
    set(s => {
      const groups = s.groups.map(g => {
        if (groupAddress(g) !== ref || g._revisionId !== row.revisionEventId) return g
        const prior = g._reconciliationRows || []
        const duplicate = prior.find(item => item.id === row.id)
        if (duplicate) return JSON.stringify(duplicate) === JSON.stringify(row) ? g :
          { ...g, _reconciliationConflict: true }
        if (prior.length >= MAX_HISTORICAL_RECONCILIATIONS)
          return { ...g, _reconciliationConflict: true }
        return { ...g, _reconciliationRows: [...prior, row] }
      })
      saveGroups(account, groups)
      return { groups }
    })
  },

  applyHistoricalAttestation: (ref, row) => {
    const group = get().getGroup(ref)
    if (!group || row?.revisionEventId !== group._revisionId) return
    const account = get().pubkey
    set(s => {
      const groups = s.groups.map(g => {
        if (groupAddress(g) !== ref || g._revisionId !== row.revisionEventId) return g
        const previous = g._historicalAttestations || []
        const known = previous.find(p => p.id === row.id)
        if (known) return JSON.stringify(known) === JSON.stringify(row) ? g :
          { ...g, _historicalAttestationConflict: true }
        if (previous.length >= MAX_HISTORICAL_ATTESTATIONS) {
          return { ...g, _historicalAttestationConflict: true }
        }
        return { ...g, _historicalAttestations: [...previous, row] }
      })
      saveGroups(account, groups)
      return { groups }
    })
    void get().refreshReconciliationCheckpoint(ref)
  },

  refreshHistoricalSnapshot: async (ref) => {
    const account = get().pubkey, group = get().getGroup(ref)
    if (!account || !group || !group._priorHistoryChecked ||
        !group._historicalActivityDetected || group._revisionStatus !== 'verified') return
    const head = group._revisionId, events = group._priorReplayEvents || []
    const replay = replayHistoricalFinancialEvents(group, events,
      { overflow: !!group._priorReplayOverflow })
    const snapshot = await buildHistoricalAttestationSnapshot(group, events, replay)
    const current = get().getGroup(ref)
    if (get().pubkey !== account || currentSessionPubkey !== account ||
        current?._revisionId !== head || current._priorReplayEvents !== events ||
        !current._priorHistoryChecked || current._priorReplayOverflow) return
    set(s => {
      const groups = s.groups.map(g => groupAddress(g) === ref && g._revisionId === head
        ? { ...g, _historicalSnapshot: snapshot } : g)
      saveGroups(account, groups)
      return { groups }
    })
    void get().refreshReconciliationCheckpoint(ref)
  },

  refreshReconciliationCheckpoint: async (ref) => {
    const account = get().pubkey, group = get().getGroup(ref)
    if (!account || !group || group._revisionStatus !== 'verified' ||
        !group._priorHistoryChecked) return
    const head = group._revisionId, events = group._priorReplayEvents || []
    const audit = group._priorRelayAudit, attestations = group._historicalAttestations || []
    const replay = replayHistoricalFinancialEvents(group, events,
      { overflow: !!group._priorReplayOverflow })
    const fresh = await buildHistoricalAttestationSnapshot(group, events, replay)
    const checkpoint = fresh?.hash === group._historicalSnapshot?.hash
      ? await buildHistoricalReconciliationCheckpoint(group, fresh, replay, audit, attestations)
      : null
    const current = get().getGroup(ref)
    if (get().pubkey !== account || currentSessionPubkey !== account ||
        current?._revisionId !== head || current?._priorReplayEvents !== events ||
        current?._priorRelayAudit !== audit || current?._historicalAttestations !== attestations ||
        current?._reconciliationDecisionsChecked !== group._reconciliationDecisionsChecked ||
        current?._historicalSnapshot?.hash !== group._historicalSnapshot?.hash ||
        current?._historicalAttestationConflict !== group._historicalAttestationConflict) return
    set(s => {
      const groups = s.groups.map(g => groupAddress(g) === ref && g._revisionId === head
        ? { ...g, _reconciliationCheckpoint: checkpoint } : g)
      saveGroups(account, groups)
      return { groups }
    })
  },

  signHistoricalReconciliation: async (ref) => {
    const account = get().pubkey, group = get().getGroup(ref)
    if (!account || !group?.members?.includes(account) ||
        group._revisionStatus !== 'verified' || !group._priorHistoryChecked ||
        group._reconciliationConflict || pendingOutbox(account).length) {
      throw new Error('Riconciliazione non disponibile o outbox in sospeso')
    }
    const flightKey = `${account}:${ref}:${group._revisionId}`
    if (inFlightReconciliations.has(flightKey))
      throw new Error('Firma della riconciliazione già in corso')
    inFlightReconciliations.add(flightKey)
    try {
    const events = group._priorReplayEvents || []
    const audit = group._priorRelayAudit, attestations = group._historicalAttestations || []
    const replay = replayHistoricalFinancialEvents(group, events,
      { overflow: !!group._priorReplayOverflow })
    const fresh = await buildHistoricalAttestationSnapshot(group, events, replay)
    const checkpoint = fresh?.hash === group._historicalSnapshot?.hash
      ? await buildHistoricalReconciliationCheckpoint(group, fresh, replay, audit, attestations)
      : null
    const current = get().getGroup(ref)
    if (!checkpoint || checkpoint.hash !== group._reconciliationCheckpoint?.hash ||
        get().pubkey !== account || currentSessionPubkey !== account ||
        current?._revisionId !== group._revisionId || current?._priorReplayEvents !== events ||
        current?._priorRelayAudit !== audit || current?._historicalAttestations !== attestations ||
        current?._reconciliationConflict || current?._historicalAttestationConflict ||
        current?._historicalSnapshot?.hash !== group._historicalSnapshot?.hash ||
        current?._reconciliationCheckpoint?.hash !== checkpoint.hash ||
        !current?._reconciliationDecisionsChecked) {
      throw new Error('Checkpoint cambiato o sincronizzazione incompleta: non firmare')
    }
    const state = historicalReconciliationSummary(group, checkpoint, group._reconciliationRows || [])
    if (state.status !== 'pending' || !state.pending.includes(account)) {
      throw new Error('Riconciliazione gia firmata o in conflitto')
    }
    const signed = await publishEvent(account, KIND_HISTORICAL_RECONCILIATION,
      { version: 1, action: 'acknowledge-reconciliation-v1', groupId: group.id,
        revisionEventId: group._revisionId, snapshotHash: checkpoint.snapshotHash,
        checkpointHash: checkpoint.hash }, historicalReconciliationTags(group, checkpoint))
    if (get().pubkey !== account || get().getGroup(ref)?._revisionId !== group._revisionId) return
    const parsed = parseHistoricalReconciliationEvent(signed, group)
    if (!parsed) throw new Error('Firma non valida: recupera solo evento originale dalla outbox')
    get().applyHistoricalReconciliation(ref, parsed)
    return signed.id
    } finally { inFlightReconciliations.delete(flightKey) }
  },

  attestHistoricalSnapshot: async (ref) => {
    const account = get().pubkey, group = get().getGroup(ref)
    if (!account || !group?.members?.includes(account) ||
        group._revisionStatus !== 'verified' || !group._priorHistoryChecked ||
        !group._historicalActivityDetected || group._priorReplayOverflow ||
        pendingOutbox(account).length) {
      throw new Error('Snapshot non verificato, firma non consentita o outbox pendente')
    }
    const events = group._priorReplayEvents || []
    const replay = replayHistoricalFinancialEvents(group, events,
      { overflow: !!group._priorReplayOverflow })
    const snapshot = await buildHistoricalAttestationSnapshot(group, events, replay)
    if (!snapshot || snapshot.hash !== group._historicalSnapshot?.hash ||
        get().pubkey !== account || get().getGroup(ref)?._revisionId !== group._revisionId ||
        get().getGroup(ref)?._priorReplayEvents !== events) {
      throw new Error('Snapshot variato o incompleto: aggiorna la ricostruzione prima di firmare')
    }
    const summary = historicalAttestationSummary(group, snapshot, group._historicalAttestations || [])
    if (group._historicalAttestationConflict || summary.status !== 'pending' ||
        !summary.pending.includes(account)) throw new Error('Attestazione gia presente o in conflitto')
    const signed = await publishEvent(account, KIND_HISTORICAL_ATTESTATION,
      { version: 1, action: 'attest-historical-v1', groupId: group.id,
        revisionEventId: group._revisionId, snapshotHash: snapshot.hash },
      historicalAttestationTags(group, snapshot))
    if (get().pubkey !== account || get().getGroup(ref)?._revisionId !== group._revisionId) return
    const parsed = parseHistoricalAttestationEvent(signed, group)
    if (!parsed) throw new Error('Firma storica non valida: recupera soltanto la outbox')
    get().applyHistoricalAttestation(ref, parsed)
    return signed.id
  },

  // ─── PHASE 2E-A: READ-ONLY OLD-HEAD FINANCIAL EVIDENCE ────────────────────
  recordPriorFinancialEvidence: (ref, head, event) => {
    const account = get().pubkey
    const group = get().getGroup(ref)
    if (!account || currentSessionPubkey !== account || !group ||
        group._revisionId !== head || group._revisionStatus !== 'verified') return
    // RelayPool verified this immutable signature before dispatch. Historical
    // 9592 acceptances are used ONLY to validate old receipts, not as debts.
    const isInvitation = event?.kind === KIND_GROUP_INVITATION
    const evidence = isInvitation ? null : priorFinancialEvidence(group, event)
    set(s => {
      const groups = s.groups.map(g => {
        if (groupAddress(g) !== ref || g._revisionId !== head) return g
        const replay = appendHistoricalReplayEvent(g._priorReplayEvents || [], event)
        const update = isInvitation
          ? { rows: g._priorFinancialEvidence || [], overflow: false }
          : evidence
            ? appendPriorEvidence(g._priorFinancialEvidence || [], evidence)
            : { rows: g._priorFinancialEvidence || [], overflow: true }
        const unsafe = !isInvitation || replay.overflow
        return { ...g, _priorReplayEvents: replay.events, _reconciliationCheckpoint: null,
          _priorReplayOverflow: !!g._priorReplayOverflow || replay.overflow,
          _priorFinancialEvidence: update.rows,
          _priorEvidenceOverflow: !!g._priorEvidenceOverflow || update.overflow || replay.overflow,
          _historicalActivityDetected: unsafe || !!g._historicalActivityDetected,
          _financialReviewRequired: unsafe || !!g._financialReviewRequired,
          _financialHistoryChecked: unsafe ? false : g._financialHistoryChecked,
          ...(unsafe ? { expenses: [], settlements: [], confirmations: [] } : {}) }
      })
      saveGroups(account, groups)
      return { groups }
    })
    if (isInvitation && !get().getGroup(ref)?._priorReplayOverflow) return
    // Any earlier financial event or replay overflow freezes current-head finance.
    for (const prefix of ['exp_', 'set_', 'conf_']) {
      activeSubs[prefix + ref]?.()
      delete activeSubs[prefix + ref]
    }
    delete subscribedMemberKeys[ref]
    void get().refreshHistoricalSnapshot(ref)
  },

  // Diagnostic only: a consistent set of relay replies is NOT network finality.
  observePriorRelayAudit: (ref, head, report) => {
    const account = get().pubkey
    if (!account || currentSessionPubkey !== account ||
        get().getGroup(ref)?._revisionId !== head || !report ||
        report.safeForPayments !== false || report.completeHistory !== false) return
    set(s => {
      const groups = s.groups.map(g => groupAddress(g) === ref && g._revisionId === head
        ? { ...g, _priorRelayAudit: report, _reconciliationCheckpoint: null } : g)
      saveGroups(account, groups)
      return { groups }
    })
    void get().refreshReconciliationCheckpoint(ref)
  },

  // ─── PRIOR-REVISION FINANCIAL SAFETY BARRIER ─────────────────────────────
  completePriorHistory: (ref, head) => {
    const account = get().pubkey
    if (!account || currentSessionPubkey !== account ||
        get().getGroup(ref)?._revisionId !== head) return
    set(s => {
      const groups = s.groups.map(g => groupAddress(g) === ref && g._revisionId === head
        ? { ...g, _priorHistoryChecked: true } : g)
      saveGroups(account, groups)
      return { groups }
    })
    get().refreshPriorHistoryGate(ref)
    void get().refreshHistoricalSnapshot(ref)
  },

  refreshPriorHistoryGate: (ref) => {
    const group = get().getGroup(ref)
    if (!group) return
    const verdict = verifyMemberExitProofs(group, group._memberExitRequests || [])
    if (!canResumeAfterPriorHistory(group, verdict)) return
    const account = get().pubkey
    set(s => {
      const groups = s.groups.map(g => groupAddress(g) === ref &&
        g._revisionId === group._revisionId && g._priorHistoryChecked &&
        !g._historicalActivityDetected
        ? { ...g, _financialReviewRequired: false, _memberExitStatus: verdict } : g)
      saveGroups(account, groups)
      return { groups }
    })
    if (get().getGroup(ref)?._consentPolicy === CONSENT_POLICY) get().watchGroupInvitations(ref)
  },

  // ─── SIGNED VOLUNTARY MEMBER EXITS ────────────────────────────────────────

  watchMemberExits: (ref) => {
    const group = get().getGroup(ref)
    const account = get().pubkey
    if (!group || !account || !group.members.includes(account) ||
        group._revisionStatus !== 'verified' || !group._consentPolicy ||
        activeSubs['leave_' + ref]) return
    const revisionId = group._revisionId
    activeSubs['leave_' + ref] = subscribeMemberExitRequests(group, parseMemberExitRequestEvent, request => {
      if (get().pubkey !== account || currentSessionPubkey !== account ||
          get().getGroup(ref)?._revisionId !== revisionId) return
      get().applyMemberExitRequest(ref, request)
    }, () => {})
  },

  applyMemberExitRequest: (ref, request) => {
    const group = get().getGroup(ref)
    if (!group || group._revisionStatus !== 'verified' ||
        (group._memberExitRequests || []).some(r => r.id === request.id)) return
    const requests = [...(group._memberExitRequests || []), request]
    const verdict = verifyMemberExitProofs(group, requests)
    const hasExit = group._revisions.some(r => !!r.exitedMember)
    const canClear = hasExit && canResumeAfterPriorHistory(group, verdict)
    set(s => {
      const groups = s.groups.map(g => groupAddress(g) === ref
        ? { ...g, _memberExitRequests: requests, _memberExitStatus: verdict,
            _financialReviewRequired: canClear ? false :
              verdict === 'conflict' ? true : g._financialReviewRequired,
            ...(verdict === 'conflict' ?
              { expenses: [], settlements: [], confirmations: [] } : {}) } : g)
      saveGroups(get().pubkey, groups)
      return { groups }
    })
    if (canClear && get().getGroup(ref)?._consentPolicy === CONSENT_POLICY) {
      get().watchGroupInvitations(ref)
    }
  },

  requestGroupExit: async (ref) => {
    const group = get().getGroup(ref), account = get().pubkey
    assertCanRequestExit(group, account, pendingOutbox(account))
    const signed = await publishEvent(account, KIND_MEMBER_EXIT,
      { groupId: group.id, revisionEventId: group._revisionId, action: 'leave' },
      memberExitTags(group))
    if (get().pubkey !== account || get().getGroup(ref)?._revisionId !== group._revisionId) return
    const parsed = parseMemberExitRequestEvent(signed, group)
    if (!parsed) throw new Error('Richiesta di uscita firmata non valida: controlla la outbox')
    get().applyMemberExitRequest(ref, parsed)
    return signed.id
  },

  // ─── SIGNED INVITATIONS ─────────────────────────────────────────────────────

  watchGroupInvitations: (ref) => {
    const group = get().getGroup(ref)
    const account = get().pubkey
    if (!group || !account || !group.members.includes(account) ||
        group._revisionStatus !== 'verified' || group._financialReviewRequired ||
        group._consentPolicy !== CONSENT_POLICY) return
    // Never open multiple subscriptions to the same revision.
    if (activeSubs['inv_' + ref]) return
    const revisionId = group._revisionId
    activeSubs['inv_' + ref] = subscribeGroupInvitations(group, decision => {
      if (get().pubkey !== account || currentSessionPubkey !== account ||
          get().getGroup(ref)?._revisionId !== revisionId) return
      get().applyInvitationDecision(ref, decision)
    }, () => {})
  },

  applyInvitationDecision: (ref, decision) => {
    const group = get().getGroup(ref)
    if (!group || group._consentPolicy !== CONSENT_POLICY ||
        group._revisionStatus !== 'verified' || decision.revisionEventId !== group._revisionId) return
    if (!group.members.includes(decision.member) || decision.member === group.pubkey) return
    const current = group._inviteDecisions || []
    if (current.some(row => row.id === decision.id)) return
    const decisions = [...current, decision]
    const result = invitationSummary(group, decisions)
    set(s => {
      const groups = s.groups.map(g => groupAddress(g) === ref
        ? { ...g, _inviteDecisions: decisions, _inviteStatus: result.status,
            ...(result.status === 'accepted' ? {} :
              { expenses: [], settlements: [], confirmations: [] }) }
        : g)
      saveGroups(get().pubkey, groups)
      return { groups }
    })
    if (result.status === 'accepted') {
      get().subscribeGroup(ref, group._revisions?.flatMap(r => r.members) || group.members)
    } else {
      for (const kind of ['exp_', 'set_', 'conf_']) {
        activeSubs[kind + ref]?.()
        delete activeSubs[kind + ref]
      }
      delete subscribedMemberKeys[ref]
    }
  },

  decideInvitation: async (ref, decision) => {
    const group = get().getGroup(ref)
    const account = get().pubkey
    if (!group || group._consentPolicy !== CONSENT_POLICY ||
        group._revisionStatus !== 'verified' || group._financialReviewRequired ||
        !group.members.includes(account) || account === group.pubkey ||
        !['accept', 'decline'].includes(decision) ||
        (group._inviteDecisions || []).some(row => row.member === account)) {
      throw new Error('Questo invito non e disponibile o e gia stato deciso')
    }
    const signed = await publishEvent(account, KIND_GROUP_INVITATION,
      { groupId: group.id, revisionEventId: group._revisionId, decision },
      invitationTags(group))
    if (get().pubkey !== account || get().getGroup(ref)?._revisionId !== group._revisionId) return
    const parsed = parseInvitationDecisionEvent(signed, group)
    if (!parsed) throw new Error('Decisione Nostr firmata non valida')
    get().applyInvitationDecision(ref, parsed)
  },

  // ─── REAL-TIME SUBSCRIPTIONS ───────────────────────────────────────────────

  subscribeGroup: (ref, members) => {
    const group = get().getGroup(ref)
    const subscriptionOwner = get().pubkey
    if (!group || !group.members.includes(subscriptionOwner) ||
        (group._revisionId && (group._revisionStatus !== 'verified' || group._financialReviewRequired)) ||
        (group._consentPolicy === CONSENT_POLICY &&
          invitationSummary(group, group._inviteDecisions || []).status !== 'accepted')) return
    const groupId = group.id
    const groupOwner = group.pubkey
    const memberKey = `${groupOwner}:${group._revisionId || 'legacy'}:${[...new Set(members)].sort().join(',')}`
    if (activeSubs['exp_' + ref] && subscribedMemberKeys[ref] === memberKey) return
    // EOSE is a best-effort sync barrier, NOT proof of complete relay history.
    // A membership change is not even offered until all streams report EOSE.
    set(s => ({ groups: s.groups.map(g => groupAddress(g) === ref
      ? { ...g, _financialHistoryChecked: false } : g) }))
    for (const type of ['exp_', 'set_', 'conf_']) activeSubs[type + ref]?.()
    subscribedMemberKeys[ref] = memberKey
    const isCurrent = () => get().pubkey === subscriptionOwner &&
      currentSessionPubkey === subscriptionOwner && subscribedMemberKeys[ref] === memberKey &&
      (!group._revisionId || (get().getGroup(ref)?._revisionStatus === 'verified' &&
        !get().getGroup(ref)?._financialReviewRequired)) &&
      (get().getGroup(ref)?._consentPolicy !== CONSENT_POLICY ||
        invitationSummary(get().getGroup(ref), get().getGroup(ref)?._inviteDecisions || []).status === 'accepted')
    const resolveEventMembers = group._revisionId
      ? event => membersForRevisionEvent(get().getGroup(ref)?._revisions, event)
      : null
    const canUseEvent = event => hasInvitationReceipts(get().getGroup(ref), event)
    const eoseKinds = new Set()
    const expectedEose = group._expensePolicy === EXPENSE_POLICY ? 5 : 3
    const markHistoryEose = kind => {
      if (!isCurrent()) return
      eoseKinds.add(kind)
      if (eoseKinds.size !== expectedEose) return
      set(s => ({ groups: s.groups.map(g =>
        groupAddress(g) === ref && g._revisionId === group._revisionId &&
        !g._financialReviewRequired && !g._expenseReviewRequired
          ? { ...g, _financialHistoryChecked: true } : g) }))
    }

    const unsubExp = subscribeExpenses(
      groupId, members,
      (expense) => {
        if (!isCurrent()) return
        set(s => {
          if (!mayApplyGroupTransaction(s.groups, ref, expense)) return s
          const groups = s.groups.map(g => {
            if (groupAddress(g) !== ref) return g
            const authorizedMembers = expense._membersAtRevision || g.members
            if (!authorizedMembers.includes(expense._pubkey) || !authorizedMembers.includes(expense.paidBy) ||
                !expense.splits.every(m => authorizedMembers.includes(m))) return g
            const pool = g._expensePolicy === EXPENSE_POLICY ? (g.proposedExpenses || []) : g.expenses
            if (pool.some(e => e._eventId === expense._eventId ||
              (e.id === expense.id && e._pubkey === expense._pubkey))) return g
            return g._expensePolicy === EXPENSE_POLICY
              ? reconcileExpenseApprovals({ ...g, proposedExpenses: [...pool, expense] })
              : { ...g, expenses: [...g.expenses, expense] }
          })
          saveGroups(subscriptionOwner, groups)
          return { groups }
        })
      },
      () => markHistoryEose('expense'), groupOwner, resolveEventMembers, canUseEvent
    )

    const unsubSet = subscribeSettlements(
      groupId, members,
      (settlement) => {
        if (!isCurrent()) return
        set(s => {
          if (!mayApplyGroupTransaction(s.groups, ref, settlement)) return s
          const groups = s.groups.map(g => {
            if (groupAddress(g) !== ref) return g
            const authorizedMembers = settlement._membersAtRevision || g.members
            if (!authorizedMembers.includes(settlement._pubkey) || settlement._pubkey !== settlement.from ||
                !authorizedMembers.includes(settlement.to)) return g
            if ((g.settlements || []).some(e =>
              e._eventId === settlement._eventId ||
              (e.id && settlement.id && e.id === settlement.id && e._pubkey === settlement._pubkey))) return g
            return { ...g, settlements: [...(g.settlements || []), settlement] }
          })
          saveGroups(subscriptionOwner, groups)
          return { groups }
        })
      },
      () => markHistoryEose('settlement'), groupOwner, resolveEventMembers, canUseEvent
    )

    const unsubConf = subscribeConfirmations(
      groupId, members,
      (confirmation) => {
        if (!isCurrent()) return
        set(s => {
          if (!mayApplyGroupTransaction(s.groups, ref, confirmation)) return s
          const groups = s.groups.map(g => {
            const authorizedMembers = confirmation._membersAtRevision || g.members
            if (groupAddress(g) !== ref || !authorizedMembers.includes(confirmation._pubkey) ||
                !authorizedMembers.includes(confirmation.from) || !authorizedMembers.includes(confirmation.to)) return g
            const confirmations = g.confirmations || []
            if (confirmations.some(c => c._eventId === confirmation._eventId)) return g
            return { ...g, confirmations: [...confirmations, confirmation] }
          })
          saveGroups(subscriptionOwner, groups)
          return { groups }
        })
        // Never unlock a Lightning attempt based on an event we quarantined,
        // or a receipt belonging to another author-scoped group.
        const matchedGroup = get().getGroup(ref)
        const settlement = matchedGroup?.settlements?.find(s =>
          s._eventId === confirmation.settlementEventId && s.from === confirmation.from &&
          s.to === confirmation.to && s.amount === confirmation.amount)
        if (settlement && !matchedGroup?._expenseReviewRequired &&
            isConfirmedSettlement(settlement, matchedGroup.confirmations || []) &&
            confirmation.from === subscriptionOwner) {
          try {
            // Keep the legacy raw-d journal key to avoid bypassing an older
            // same-device payment lock after migration to canonical group refs.
            releaseConfirmedPaymentAttempt(
              { account: subscriptionOwner, groupId, to: settlement.to }, settlement._eventId)
          } catch { /* Keep fail-closed on storage errors. */ }
        }
      },
      () => markHistoryEose('confirmation'), groupOwner, resolveEventMembers, canUseEvent
    )

    activeSubs['conf_' + ref] = unsubConf
    activeSubs['exp_' + ref] = unsubExp
    activeSubs['set_' + ref] = unsubSet
    if (group._expensePolicy === EXPENSE_POLICY) {
      activeSubs['approval_' + ref]?.()
      activeSubs['approval_' + ref] = subscribeExpenseDecisions(group, decision => {
        if (!isCurrent()) return
        set(s => {
          const groups = s.groups.map(g => {
            if (groupAddress(g) !== ref || g._revisionId !== decision.revisionEventId ||
                (g._expenseDecisions || []).some(d => d.id === decision.id)) return g
            return reconcileExpenseApprovals({ ...g,
              _expenseDecisions: [...(g._expenseDecisions || []), decision] })
          })
          saveGroups(subscriptionOwner, groups)
          return { groups }
        })
      }, () => markHistoryEose('approval'))
      activeSubs['cancel_' + ref]?.()
      activeSubs['cancel_' + ref] = subscribeExpenseCancellations(group, cancellation => {
        if (get().pubkey !== subscriptionOwner || currentSessionPubkey !== subscriptionOwner ||
            get().getGroup(ref)?._revisionId !== cancellation.revisionEventId) return
        get().applyExpenseCancellation(ref, cancellation)
      }, () => markHistoryEose('cancellation'))
    }
  },

  // ─── PROFILES ──────────────────────────────────────────────────────────────

  fetchAndCacheProfile: (hexPubkey, force = false) => {
    if (!hexPubkey) return
    const cached = get().profiles[hexPubkey]
    if (!force && cached && (cached.name || cached.display_name || cached.lud16)) return
    const subKey = 'profile_' + hexPubkey
    activeSubs[subKey]?.()
    const sessionOwner = get().pubkey
    activeSubs[subKey] = fetchProfile(hexPubkey, (pk, meta) => {
      if (sessionOwner !== get().pubkey) return
      set(s => {
        const updated = { ...s.profiles, [pk]: meta }
        saveProfiles(get().pubkey, updated)
        return { profiles: updated }
      })
    })
  },

  // ─── GROUPS ────────────────────────────────────────────────────────────────

  createGroup: async ({ name, members }) => {
    const { pubkey } = get()
    if (!validPubkey(pubkey) || typeof name !== 'string' || !name.trim() || name.length > 100 ||
        !Array.isArray(members) || members.length < 2 || members.length > 100 ||
        new Set(members).size !== members.length || !members.every(validPubkey) ||
        !members.includes(pubkey)) throw new Error('Nome o membri del gruppo non validi')
    const groupId = randId()
    const baseGroup = { id: groupId, pubkey }
    // Publish immutable genesis BEFORE the replaceable group definition.
    // Partial delivery is recoverable via the signed outbox, not a new event.
    const signedRevision = await publishEvent(pubkey, KIND_GROUP_REVISION,
      { groupId, version: 0, previousRevisionId: null, members,
        consentPolicy: CONSENT_POLICY, expensePolicy: EXPENSE_POLICY },
      revisionTags(baseGroup, members))
    const groupData = { id: groupId, name, members, createdAt: now(),
      revisionEventId: signedRevision.id }

    const signed = await publishEvent(pubkey, KIND_GROUP, groupData, [
      ['d', groupId], ['r', signedRevision.id],
      ['t', 'splitsats'],
      ...members.map(m => ['p', m]),
    ])

    if (get().pubkey !== pubkey) return groupId // event accepted for the prior account

    const ownRevision = parseGroupRevisionEvent(signedRevision, baseGroup)
    if (!ownRevision) throw new Error('Revisione Nostr firmata non valida: sincronizza la outbox')
    const newGroup = { ...groupData, pubkey, eventId: signed.id,
      _revisionId: signedRevision.id, _revisions: [ownRevision],
      _revisionStatus: 'verified', _financialReviewRequired: false,
      _consentPolicy: CONSENT_POLICY, _inviteDecisions: [], _inviteStatus: 'pending',
      _expensePolicy: EXPENSE_POLICY, proposedExpenses: [], _expenseDecisions: [],
      _cancellationDecisions: [], _expenseReviewRequired: false,
      _financialHistoryChecked: false,
      _groupCreatedAt: signed.created_at, expenses: [], settlements: [], confirmations: [], _synced: true }
    set(s => {
      const merged = mergeVerifiedGroup(s.groups, newGroup)
      const ref = groupAddress(newGroup)
      // The creator has already signed, published and parsed the exact
      // immutable genesis AND the replaceable group definition. Do not
      // discard that locally verified history while waiting for a relay echo.
      // A different or newer group head must never inherit this approval.
      const updated = merged.map(g =>
        groupAddress(g) === ref && g.eventId === signed.id &&
        g._revisionId === signedRevision.id
          ? { ...g, _revisions: [ownRevision], _revisionStatus: 'verified',
              _financialReviewRequired: false, _consentPolicy: CONSENT_POLICY,
              _inviteDecisions: [], _inviteStatus: 'pending',
              _expensePolicy: EXPENSE_POLICY, proposedExpenses: [],
              _expenseDecisions: [], _cancellationDecisions: [], _expenseReviewRequired: false,
              _financialHistoryChecked: false }
          : g)
      saveGroups(pubkey, updated)
      return { groups: updated, toast: `Gruppo "${name}" creato` }
    })

    // The creator can now subscribe immediately, even if the relay has not
    // echoed the group definition yet. Other accounts must still independently
    // reconstruct the signed immutable revision chain from relays.
    get().watchGroupInvitations(groupAddress(newGroup))
    get().watchMemberExits(groupAddress(newGroup))
    members.forEach(m => get().fetchAndCacheProfile(m))
    return groupId
  },

  // ─── PHASE 2D-A: OWNER-SIGNED MEMBER ADDITION ───────────────────────────

  addGroupMember: async (ref, rawMember) => {
    const account = get().pubkey
    const group = get().getGroup(ref)
    const member = npubToHex(typeof rawMember === 'string' ? rawMember.trim() : '')
    const nextMembers = assertCanAddGroupMember(group, account, member, pendingOutbox(account))
    const previousHead = group._revisionId
    const nextVersion = group._revisions.at(-1).version + 1
    // Step 1: immutable revision; if the definition cannot be published,
    // the durable outbox retains the exact signed bytes. NEVER sign a new
    // revision until a failed/uncertain publication has been reconciled.
    const signedRevision = await publishEvent(account, KIND_GROUP_REVISION,
      { groupId: group.id, version: nextVersion,
        previousRevisionId: previousHead, members: nextMembers },
      revisionTags(group, nextMembers, previousHead))
    const parsed = parseGroupRevisionEvent(signedRevision, group)
    if (!parsed) throw new Error('Revisione firmata non valida: verifica la outbox')
    const chainResult = verifyGroupRevisionHistory(
      { ...group, members: nextMembers, _revisionId: signedRevision.id },
      [...group._revisions, parsed])
    if (chainResult.status !== 'verified' || chainResult.removedMembers.length) {
      throw new Error('Nuova catena non verificabile: blocco di sicurezza')
    }
    if (get().pubkey !== account || get().getGroup(ref)?._revisionId !== previousHead) {
      throw new Error('Account o revisione cambiati: non firmare nuovi eventi, verifica la outbox')
    }
    // Step 2: replaceable signed definition points to the exact immutable head.
    const signed = await publishEvent(account, KIND_GROUP,
      { id: group.id, name: group.name, members: nextMembers,
        createdAt: group.createdAt, revisionEventId: signedRevision.id },
      [['d', group.id], ['r', signedRevision.id], ['t', 'splitsats'],
        ...nextMembers.map(pk => ['p', pk])])
    if (get().pubkey !== account) return
    const incoming = { ...group, members: nextMembers, _revisionId: signedRevision.id,
      eventId: signed.id, _groupCreatedAt: signed.created_at }
    set(s => {
      const next = mergeVerifiedGroup(s.groups, incoming).map(g =>
        groupAddress(g) === ref && g.eventId === signed.id &&
        g._revisionId === signedRevision.id
          ? { ...g, _revisions: chainResult.chain, _revisionStatus: 'verified',
              _financialReviewRequired: true, _financialHistoryChecked: false,
              _priorHistoryChecked: false,
              _priorFinancialEvidence: [], _priorEvidenceOverflow: false,
              _priorReplayEvents: [], _priorReplayOverflow: false,
              _priorRelayAudit: null,
              _historicalSnapshot: null, _historicalAttestations: [],
              _historicalAttestationConflict: false,
              _consentPolicy: chainResult.consentPolicy, _inviteDecisions: [],
              _inviteStatus: 'pending', _expensePolicy: chainResult.expensePolicy,
              proposedExpenses: [], _expenseDecisions: [], _cancellationDecisions: [],
              _expenseReviewRequired: false, expenses: [], settlements: [], confirmations: [] }
          : g)
      saveGroups(account, next)
      return { groups: next, toast: 'Membro aggiunto: in attesa di nuovi consensi Nostr' }
    })
    // Stop listeners for the old head and listen for fresh signed consents.
    for (const kind of ['exp_', 'set_', 'conf_', 'approval_', 'cancel_', 'inv_', 'rev_', 'prior_', 'leave_', 'historic_attest_']) {
      activeSubs[kind + ref]?.()
      delete activeSubs[kind + ref]
    }
    delete subscribedMemberKeys[ref]
    const current = get().getGroup(ref)
    if (current?._revisionId === signedRevision.id) {
      if (chainResult.chain.length > 1) {
        activeSubs['prior_' + ref] = subscribePriorRevisionActivity(current, chainResult.chain, event => get().recordPriorFinancialEvidence(ref, signedRevision.id, event), () => get().completePriorHistory(ref, signedRevision.id), report => get().observePriorRelayAudit(ref, signedRevision.id, report))
      }
      get().watchGroupInvitations(ref)
      get().watchMemberExits(ref)
      get().watchHistoricalAttestations(ref)
    }
    get().fetchAndCacheProfile(member)
    return signedRevision.id
  },

  // ─── PHASE 2D-B: OWNER FINALIZES A VOLUNTARY EXIT ─────────────────────

  finalizeGroupExit: async (ref, member) => {
    const group = get().getGroup(ref), account = get().pubkey
    const request = (group?._memberExitRequests || []).find(r => r.member === member &&
      r.revisionEventId === group._revisionId)
    const nextMembers = assertCanFinalizeExit(group, account, request, pendingOutbox(account))
    const before = group._revisionId
    const nextVersion = group._revisions.at(-1).version + 1
    const signedRevision = await publishEvent(account, KIND_GROUP_REVISION,
      { groupId: group.id, version: nextVersion, previousRevisionId: before,
        members: nextMembers, exitedMember: member, exitProofEventId: request.id },
      [...revisionTags(group, nextMembers, before), ['x', request.id]])
    const parsed = parseGroupRevisionEvent(signedRevision, group)
    if (!parsed) throw new Error('Revisione di uscita non valida: recupera soltanto la outbox')
    const result = verifyGroupRevisionHistory(
      { ...group, members: nextMembers, _revisionId: signedRevision.id },
      [...group._revisions, parsed])
    if (result.status !== 'verified' || result.removedMembers.length !== 1 ||
        verifyMemberExitProofs({ ...group, members: nextMembers,
          _revisionId: signedRevision.id, _revisions: result.chain },
          group._memberExitRequests || []) !== 'verified') {
      throw new Error('Uscita non verificabile: non firmare nuovi eventi')
    }
    if (get().pubkey !== account || get().getGroup(ref)?._revisionId !== before) {
      throw new Error('Sessione o revisione cambiata: recupera la outbox')
    }
    const definition = await publishEvent(account, KIND_GROUP,
      { id: group.id, name: group.name, members: nextMembers,
        createdAt: group.createdAt, revisionEventId: signedRevision.id },
      [['d', group.id], ['r', signedRevision.id], ['t', 'splitsats'],
        ...nextMembers.map(m => ['p', m])])
    if (get().pubkey !== account) return
    const incoming = { ...group, members: nextMembers, _revisionId: signedRevision.id,
      eventId: definition.id, _groupCreatedAt: definition.created_at }
    set(s => {
      const groups = mergeVerifiedGroup(s.groups, incoming).map(g =>
        groupAddress(g) === ref && g.eventId === definition.id &&
        g._revisionId === signedRevision.id
          ? { ...g, _revisions: result.chain, _revisionStatus: 'verified',
              _financialReviewRequired: true, _financialHistoryChecked: false,
              _priorHistoryChecked: false, _historicalActivityDetected: false,
              _priorFinancialEvidence: [], _priorEvidenceOverflow: false,
              _priorReplayEvents: [], _priorReplayOverflow: false,
              _priorRelayAudit: null,
              _historicalSnapshot: null, _historicalAttestations: [],
              _historicalAttestationConflict: false,
              _memberExitRequests: [...(group._memberExitRequests || [])],
              _memberExitStatus: 'verified',
              _consentPolicy: result.consentPolicy, _inviteDecisions: [],
              _inviteStatus: 'pending', _expensePolicy: result.expensePolicy,
              proposedExpenses: [], _expenseDecisions: [], _cancellationDecisions: [],
              _expenseReviewRequired: false, expenses: [], settlements: [], confirmations: [] }
          : g)
      saveGroups(account, groups)
      return { groups, toast: 'Uscita registrata: in attesa dei nuovi consensi' }
    })
    for (const prefix of ['exp_', 'set_', 'conf_', 'approval_', 'cancel_', 'inv_', 'rev_', 'prior_', 'leave_', 'historic_attest_']) {
      activeSubs[prefix + ref]?.()
      delete activeSubs[prefix + ref]
    }
    delete subscribedMemberKeys[ref]
    const current = get().getGroup(ref)
    if (current?._revisionId === signedRevision.id) {
      // Monitor old financial activity but never rewrite older signed events.
      activeSubs['prior_' + ref] = subscribePriorRevisionActivity(current, result.chain, event => get().recordPriorFinancialEvidence(ref, signedRevision.id, event), () => get().completePriorHistory(ref, signedRevision.id), report => get().observePriorRelayAudit(ref, signedRevision.id, report))
      get().watchMemberExits(ref)
      get().watchHistoricalAttestations(ref)
      get().watchGroupInvitations(ref)
    }
    return signedRevision.id
  },

  // ─── EXPENSES ──────────────────────────────────────────────────────────────

  addExpense: async (groupRef, expense) => {
    const { pubkey } = get()
    const group      = get().getGroup(groupRef)
    if (!group || !group.members.includes(pubkey)) throw new Error('Non sei membro di questo gruppo')
    if (group._consentPolicy === CONSENT_POLICY &&
        invitationSummary(group, group._inviteDecisions || []).status !== 'accepted')
      throw new Error('Inviti non accettati: nessuna spesa puo essere registrata')
    if (group._expenseReviewRequired) throw new Error('Spese contestate: operazioni bloccate')
    if (group._revisionId && (group._revisionStatus !== 'verified' || group._financialReviewRequired))
      throw new Error('Storico del gruppo incompleto o da riconciliare: operazione bloccata')
    if (!Number.isSafeInteger(expense.amount) || expense.amount <= 0 ||
        !group.members.includes(expense.paidBy) || !Array.isArray(expense.splits) ||
        !expense.splits.length || new Set(expense.splits).size !== expense.splits.length ||
        !expense.splits.every(m => group.members.includes(m)) ||
        typeof expense.description !== 'string' || !expense.description.trim()) {
      throw new Error('Dati della spesa non validi')
    }

    if (!groupAddress(group)) throw new Error('Autore del gruppo non verificato: sincronizza prima di inviare spese')
    const expenseData = { ...expense, id: randId(), createdAt: now() }

    const signed = await publishEvent(pubkey, KIND_EXPENSE, expenseData, [
      ['g', group.id], ['a', groupAddress(group)],
      ...(group._revisionId ? [['r', group._revisionId]] : []),
      ...(group._consentPolicy === CONSENT_POLICY ? invitationReceiptTags(group) : []),
      ['t', 'splitsats'],
      ...group.members.map(m => ['p', m]),
    ])

    if (get().pubkey !== pubkey) return // keep event associated with its signing account

    const localExpense = { ...expenseData, _eventId: signed.id, _pubkey: pubkey, _signedAt: signed.created_at }
    set(s => {
      const groups = s.groups.map(g => {
        if (groupAddress(g) !== groupRef) return g
        const pool = g._expensePolicy === EXPENSE_POLICY ? (g.proposedExpenses || []) : g.expenses
        if (pool.some(e => e._eventId === signed.id ||
          (e.id === expenseData.id && e._pubkey === pubkey))) return g
        return g._expensePolicy === EXPENSE_POLICY
          ? reconcileExpenseApprovals({ ...g, proposedExpenses: [...pool, localExpense] })
          : { ...g, expenses: [...g.expenses, localExpense] }
      })
      saveGroups(get().pubkey, groups)
      return { groups, toast: `"${expense.description}" — ${expense.amount.toLocaleString()} sats` }
    })
  },

  // ─── EXPENSE APPROVAL / DISPUTE ────────────────────────────────────────────

  decideExpense: async (ref, expenseEventId, decision) => {
    const account = get().pubkey
    const group = get().getGroup(ref)
    const expense = group?.proposedExpenses?.find(e => e._eventId === expenseEventId)
    if (!group || !expense || group._expensePolicy !== EXPENSE_POLICY ||
        group._revisionStatus !== 'verified' || group._financialReviewRequired ||
        group._expenseReviewRequired || !['approve', 'dispute'].includes(decision)) {
      throw new Error('Spesa non disponibile per approvazione o contestazione')
    }
    const result = expenseApprovalSummary(group, expense, group._expenseDecisions || [])
    if (!result.required?.includes(account) || !result.pending.includes(account) ||
        result.status !== 'pending') throw new Error('Hai gia deciso o non sei coinvolto nella spesa')
    const signed = await publishEvent(account, KIND_EXPENSE_DECISION,
      { groupId: group.id, revisionEventId: group._revisionId,
        expenseEventId: expense._eventId, expenseAuthor: expense._pubkey, decision },
      expenseDecisionTags(group, expense))
    if (get().pubkey !== account || get().getGroup(ref)?._revisionId !== group._revisionId) return
    const parsed = parseExpenseDecisionEvent(signed, group)
    if (!parsed) throw new Error('Decisione firmata non valida: controlla la outbox')
    set(s => {
      const groups = s.groups.map(g => {
        if (groupAddress(g) !== ref || (g._expenseDecisions || []).some(d => d.id === parsed.id)) return g
        return reconcileExpenseApprovals({ ...g,
          _expenseDecisions: [...(g._expenseDecisions || []), parsed] })
      })
      saveGroups(account, groups)
      return { groups }
    })
  },

  // ─── SIGNED DISPUTED EXPENSE CANCELLATION ────────────────────────────────

  applyExpenseCancellation: (ref, cancellation) => {
    const group = get().getGroup(ref)
    if (!group || group._expensePolicy !== EXPENSE_POLICY ||
        group._revisionStatus !== 'verified' || group._financialReviewRequired ||
        group._revisionId !== cancellation.revisionEventId ||
        !group.members.includes(cancellation.member)) return
    set(s => {
      const groups = s.groups.map(g => {
        if (groupAddress(g) !== ref ||
            (g._cancellationDecisions || []).some(d => d.id === cancellation.id)) return g
        return reconcileExpenseApprovals({ ...g,
          _cancellationDecisions: [...(g._cancellationDecisions || []), cancellation] })
      })
      saveGroups(get().pubkey, groups)
      return { groups }
    })
  },

  cancelDisputedExpense: async (ref, expenseEventId) => {
    const account = get().pubkey
    const group = get().getGroup(ref)
    const expense = group?.proposedExpenses?.find(row => row._eventId === expenseEventId)
    if (!account || !group || !expense || group._expensePolicy !== EXPENSE_POLICY ||
        group._revisionStatus !== 'verified' || group._financialReviewRequired ||
        (group._consentPolicy === CONSENT_POLICY &&
          invitationSummary(group, group._inviteDecisions || []).status !== 'accepted')) {
      throw new Error('Annullamento non disponibile: gruppo non verificato')
    }
    const approvals = expenseApprovalSummary(group, expense, group._expenseDecisions || [])
    const cancellation = expenseCancellationSummary(group, expense,
      group._cancellationDecisions || [], approvals.status)
    if (approvals.status !== 'disputed' || cancellation.status === 'blocked' ||
        cancellation.status === 'conflict' || cancellation.status === 'cancelled' ||
        cancellation.signed.includes(account) ||
        !(new Set([expense._pubkey, expense.paidBy, ...expense.splits])).has(account) ||
        (group.settlements || []).length || (group.confirmations || []).length) {
      throw new Error('Solo i partecipanti possono firmare l’annullamento di una spesa contestata e non pagata')
    }
    const signed = await publishEvent(account, KIND_EXPENSE_CANCELLATION,
      { groupId: group.id, revisionEventId: group._revisionId,
        expenseEventId: expense._eventId, expenseAuthor: expense._pubkey, action: 'cancel' },
      expenseCancellationTags(group, expense))
    if (get().pubkey !== account || get().getGroup(ref)?._revisionId !== group._revisionId) return
    const parsed = parseExpenseCancellationEvent(signed, group)
    if (!parsed) throw new Error('Firma di annullamento non valida: riprova soltanto la outbox')
    get().applyExpenseCancellation(ref, parsed)
  },

  // ─── SETTLEMENTS ───────────────────────────────────────────────────────────

  recordSettlement: async (groupRef, { from, to, amount, method = 'manual', walletReported = false }) => {
    const { pubkey } = get()
    const group = get().getGroup(groupRef)
    if (group?._revisionId && (group._revisionStatus !== 'verified' || group._financialReviewRequired))
      throw new Error('Storico del gruppo incompleto o da riconciliare: pagamento bloccato')
    if (group?._consentPolicy === CONSENT_POLICY &&
        invitationSummary(group, group._inviteDecisions || []).status !== 'accepted')
      throw new Error('Inviti non accettati: pagamento bloccato')
    if (group?._expenseReviewRequired) throw new Error('Spesa contestata: pagamento bloccato')
    if (!group || !group.members.includes(from) || !group.members.includes(to) ||
        from !== pubkey || from === to || !Number.isSafeInteger(amount) || amount <= 0 ||
        !['manual', 'webln'].includes(method) ||
        (walletReported && method !== 'webln')) {
      throw new Error('Puoi dichiarare soltanto i tuoi pagamenti validi')
    }
    // A second unresolved claim for the same pair risks an accidental double payment.
    if ((group.settlements || []).some(s => s.from === from && s.to === to &&
        !isConfirmedSettlement(s, group.confirmations || []))) {
      throw new Error('Hai gia un pagamento in attesa di conferma verso questo destinatario')
    }
    if (!groupAddress(group)) throw new Error('Autore del gruppo non verificato: sincronizza prima di registrare il pagamento')
    const data = { id: randId(), from, to, amount, method, walletReported, settledAt: now() }

    const signed = await publishEvent(pubkey, KIND_SETTLEMENT, data, [
      ['g', group.id], ['a', groupAddress(group)],
      ...(group._revisionId ? [['r', group._revisionId]] : []),
      ...(group._consentPolicy === CONSENT_POLICY ? invitationReceiptTags(group) : []),
      ['p', to], ['t', 'splitsats'],
    ])

    if (get().pubkey !== pubkey) return

    const localSettlement = { ...data, _eventId: signed.id, _pubkey: pubkey }
    set(s => {
      const groups = s.groups.map(g => {
        if (groupAddress(g) !== groupRef) return g
        const settlements = g.settlements || []
        if (settlements.some(s => s._eventId === signed.id ||
          (s.id === data.id && s._pubkey === pubkey))) return g
        return { ...g, settlements: [...settlements, localSettlement] }
      })
      saveGroups(get().pubkey, groups)
      return { groups, toast: 'Richiesta registrata: in attesa di conferma del destinatario' }
    })
    return signed.id // Lets the durable payment journal track the exact declaration.
  },

  // ─── PAYEE CONFIRMATION (independent Nostr signature) ────────────────────

  confirmSettlement: async (groupRef, settlementId) => {
    const { pubkey } = get()
    const group = get().getGroup(groupRef)
    if (group?._revisionId && (group._revisionStatus !== 'verified' || group._financialReviewRequired))
      throw new Error('Storico del gruppo incompleto o da riconciliare: conferma bloccata')
    if (group?._consentPolicy === CONSENT_POLICY &&
        invitationSummary(group, group._inviteDecisions || []).status !== 'accepted')
      throw new Error('Inviti non accettati: conferma bloccata')
    if (group?._expenseReviewRequired) throw new Error('Spesa contestata: conferma bloccata')
    const settlement = group?.settlements?.find(s => s._eventId === settlementId)
    if (!group || !settlement || settlement.to !== pubkey ||
        !group.members.includes(settlement.from) || !group.members.includes(pubkey)) {
      throw new Error('Solo il destinatario puo confermare questo pagamento')
    }
    if (isConfirmedSettlement(settlement, group.confirmations || [])) {
      throw new Error('Questo pagamento e gia confermato')
    }
    if (!groupAddress(group)) throw new Error('Autore del gruppo non verificato: sincronizza prima di confermare')
    const data = {
      id: randId(), settlementEventId: settlement._eventId,
      from: settlement.from, to: settlement.to, amount: settlement.amount,
      confirmedAt: now(),
    }
    const signed = await publishEvent(pubkey, KIND_CONFIRMATION, data, [
      ['g', group.id], ['a', groupAddress(group)],
      ...(group._revisionId ? [['r', group._revisionId]] : []),
      ...(group._consentPolicy === CONSENT_POLICY ? invitationReceiptTags(group) : []),
      ['e', settlement._eventId], ['p', settlement.from], ['t', 'splitsats'],
    ])
    if (get().pubkey !== pubkey) return
    const confirmation = { ...data, _eventId: signed.id, _pubkey: pubkey }
    set(s => {
      const groups = s.groups.map(g => {
        if (groupAddress(g) !== groupRef) return g
        if ((g.confirmations || []).some(c => c.settlementEventId === settlement._eventId &&
            c._pubkey === pubkey)) return g
        return { ...g, confirmations: [...(g.confirmations || []), confirmation] }
      })
      saveGroups(get().pubkey, groups)
      return { groups, toast: 'Ricezione confermata: il saldo e stato aggiornato' }
    })
  },

  // ─── TOAST ─────────────────────────────────────────────────────────────────

  clearToast: () => set({ toast: null }),
  showToast:  (msg) => set({ toast: msg }),
}))