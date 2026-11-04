import { create } from 'zustand'
import { saveGroups, loadProfiles, saveProfiles, loadPubkey, savePubkey, clearAll, clearPubkey } from '../lib/storage'
import { verifyCachedSigner } from '../lib/session-identity'
import { publishEvent, fetchProfile, fetchGroups, subscribeGroupRevisions, subscribeGroupInvitations, subscribeExpenseDecisions, subscribeExpenseCancellations, subscribeExpenses, subscribeSettlements, subscribeConfirmations, pool, npubToHex } from '../lib/nostr'
import { KIND_GROUP, KIND_EXPENSE, KIND_SETTLEMENT, KIND_CONFIRMATION, KIND_GROUP_REVISION, KIND_GROUP_INVITATION, KIND_EXPENSE_DECISION, KIND_EXPENSE_CANCELLATION } from '../lib/constants'
import { validPubkey } from '../lib/event-validation'
import { groupAddress } from '../lib/group-history'
import { parseGroupRevisionEvent, revisionTags, verifyGroupRevisionHistory, membersForRevisionEvent } from '../lib/group-revision-log'
import { findGroupByRef, mergeVerifiedGroup, mayApplyGroupTransaction } from '../lib/group-state'
import { releaseConfirmedPaymentAttempt } from '../lib/payment-attempts'
import { isConfirmedSettlement } from '../lib/settlement-status'
import { CONSENT_POLICY, invitationTags, parseInvitationDecisionEvent, invitationSummary, invitationReceiptTags, hasInvitationReceipts } from '../lib/group-invitations'
import { EXPENSE_POLICY, expenseDecisionTags, parseExpenseDecisionEvent, expenseApprovalSummary, reconcileExpenseApprovals } from '../lib/expense-approvals'
import { expenseCancellationTags, parseExpenseCancellationEvent, expenseCancellationSummary } from '../lib/expense-cancellations'

const randId = () => crypto.randomUUID()
const now    = () => Math.floor(Date.now() / 1000)

const activeSubs = {}
const subscribedMemberKeys = {}
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
                      _financialReviewRequired: result.removedMembers.length > 0,
                      _consentPolicy: result.consentPolicy, _inviteDecisions: [],
                      _inviteStatus: result.consentPolicy ? 'pending' : 'legacy',
                      _expensePolicy: result.expensePolicy, proposedExpenses: [],
                      _expenseDecisions: [], _cancellationDecisions: [], _expenseReviewRequired: false,
                      expenses: [], settlements: [], confirmations: [] }
                    : g)
                  saveGroups(pubkey, groups)
                  return { groups }
                })
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
      () => {}, groupOwner, resolveEventMembers, canUseEvent
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
      () => {}, groupOwner, resolveEventMembers, canUseEvent
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
      () => {}, groupOwner, resolveEventMembers, canUseEvent
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
      }, () => {})
      activeSubs['cancel_' + ref]?.()
      activeSubs['cancel_' + ref] = subscribeExpenseCancellations(group, cancellation => {
        if (get().pubkey !== subscriptionOwner || currentSessionPubkey !== subscriptionOwner ||
            get().getGroup(ref)?._revisionId !== cancellation.revisionEventId) return
        get().applyExpenseCancellation(ref, cancellation)
      }, () => {})
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
              _expenseDecisions: [], _cancellationDecisions: [], _expenseReviewRequired: false }
          : g)
      saveGroups(pubkey, updated)
      return { groups: updated, toast: `Gruppo "${name}" creato` }
    })

    // The creator can now subscribe immediately, even if the relay has not
    // echoed the group definition yet. Other accounts must still independently
    // reconstruct the signed immutable revision chain from relays.
    get().watchGroupInvitations(groupAddress(newGroup))
    members.forEach(m => get().fetchAndCacheProfile(m))
    return groupId
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