import { create } from 'zustand'
import { saveGroups, loadProfiles, saveProfiles, loadPubkey, savePubkey, clearAll, clearPubkey } from '../lib/storage'
import { verifyCachedSigner } from '../lib/session-identity'
import { publishEvent, fetchProfile, fetchGroups, subscribeExpenses, subscribeSettlements, subscribeConfirmations, pool, npubToHex } from '../lib/nostr'
import { KIND_GROUP, KIND_EXPENSE, KIND_SETTLEMENT, KIND_CONFIRMATION } from '../lib/constants'
import { validPubkey } from '../lib/event-validation'
import { groupAddress } from '../lib/group-history'
import { findGroupByRef, mergeVerifiedGroup, mayApplyGroupTransaction } from '../lib/group-state'
import { releaseConfirmedPaymentAttempt } from '../lib/payment-attempts'
import { isConfirmedSettlement } from '../lib/settlement-status'

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
        // A new author with a colliding d-tag remains an independent group.
        get().subscribeGroup(ref, groupData.members)
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

  // ─── REAL-TIME SUBSCRIPTIONS ───────────────────────────────────────────────

  subscribeGroup: (ref, members) => {
    const group = get().getGroup(ref)
    const subscriptionOwner = get().pubkey
    if (!group || !group.members.includes(subscriptionOwner)) return
    const groupId = group.id
    const groupOwner = group.pubkey
    const memberKey = `${groupOwner}:${[...new Set(members)].sort().join(',')}`
    if (activeSubs['exp_' + ref] && subscribedMemberKeys[ref] === memberKey) return
    for (const type of ['exp_', 'set_', 'conf_']) activeSubs[type + ref]?.()
    subscribedMemberKeys[ref] = memberKey
    const isCurrent = () => get().pubkey === subscriptionOwner &&
      currentSessionPubkey === subscriptionOwner && subscribedMemberKeys[ref] === memberKey

    const unsubExp = subscribeExpenses(
      groupId, members,
      (expense) => {
        if (!isCurrent()) return
        set(s => {
          if (!mayApplyGroupTransaction(s.groups, ref, expense)) return s
          const groups = s.groups.map(g => {
            if (groupAddress(g) !== ref) return g
            if (!g.members.includes(expense._pubkey) || !g.members.includes(expense.paidBy) ||
                !expense.splits.every(m => g.members.includes(m))) return g
            if (g.expenses.some(e => e._eventId === expense._eventId ||
              (e.id === expense.id && e._pubkey === expense._pubkey))) return g
            return { ...g, expenses: [...g.expenses, expense] }
          })
          saveGroups(subscriptionOwner, groups)
          return { groups }
        })
      },
      () => {}, groupOwner
    )

    const unsubSet = subscribeSettlements(
      groupId, members,
      (settlement) => {
        if (!isCurrent()) return
        set(s => {
          if (!mayApplyGroupTransaction(s.groups, ref, settlement)) return s
          const groups = s.groups.map(g => {
            if (groupAddress(g) !== ref) return g
            if (!g.members.includes(settlement._pubkey) || settlement._pubkey !== settlement.from ||
                !g.members.includes(settlement.to)) return g
            if ((g.settlements || []).some(e =>
              e._eventId === settlement._eventId ||
              (e.id && settlement.id && e.id === settlement.id && e._pubkey === settlement._pubkey))) return g
            return { ...g, settlements: [...(g.settlements || []), settlement] }
          })
          saveGroups(subscriptionOwner, groups)
          return { groups }
        })
      },
      () => {}, groupOwner
    )

    const unsubConf = subscribeConfirmations(
      groupId, members,
      (confirmation) => {
        if (!isCurrent()) return
        set(s => {
          if (!mayApplyGroupTransaction(s.groups, ref, confirmation)) return s
          const groups = s.groups.map(g => {
            if (groupAddress(g) !== ref || !g.members.includes(confirmation._pubkey) ||
                !g.members.includes(confirmation.from) || !g.members.includes(confirmation.to)) return g
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
        if (settlement && isConfirmedSettlement(settlement, matchedGroup.confirmations || []) &&
            confirmation.from === subscriptionOwner) {
          try {
            // Keep the legacy raw-d journal key to avoid bypassing an older
            // same-device payment lock after migration to canonical group refs.
            releaseConfirmedPaymentAttempt(
              { account: subscriptionOwner, groupId, to: settlement.to }, settlement._eventId)
          } catch { /* Keep fail-closed on storage errors. */ }
        }
      },
      () => {}, groupOwner
    )

    activeSubs['conf_' + ref] = unsubConf
    activeSubs['exp_' + ref] = unsubExp
    activeSubs['set_' + ref] = unsubSet
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
    const groupId   = randId()
    const groupData = { id: groupId, name, members, createdAt: now() }

    const signed = await publishEvent(pubkey, KIND_GROUP, groupData, [
      ['d', groupId],
      ['t', 'splitsats'],
      ...members.map(m => ['p', m]),
    ])

    if (get().pubkey !== pubkey) return groupId // event accepted for the prior account

    const newGroup = { ...groupData, pubkey, eventId: signed.id,
      _groupCreatedAt: signed.created_at, expenses: [], settlements: [], confirmations: [], _synced: true }
    set(s => {
      const updated = mergeVerifiedGroup(s.groups, newGroup)
      saveGroups(pubkey, updated)
      return { groups: updated, toast: `Gruppo "${name}" creato` }
    })

    get().subscribeGroup(groupAddress(newGroup), members)
    members.forEach(m => get().fetchAndCacheProfile(m))
    return groupId
  },

  // ─── EXPENSES ──────────────────────────────────────────────────────────────

  addExpense: async (groupRef, expense) => {
    const { pubkey } = get()
    const group      = get().getGroup(groupRef)
    if (!group || !group.members.includes(pubkey)) throw new Error('Non sei membro di questo gruppo')
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
      ['t', 'splitsats'],
      ...group.members.map(m => ['p', m]),
    ])

    if (get().pubkey !== pubkey) return // keep event associated with its signing account

    const localExpense = { ...expenseData, _eventId: signed.id, _pubkey: pubkey }
    set(s => {
      const groups = s.groups.map(g => {
        if (groupAddress(g) !== groupRef) return g
        if (g.expenses.some(e => e._eventId === signed.id ||
          (e.id === expenseData.id && e._pubkey === pubkey))) return g
        return { ...g, expenses: [...g.expenses, localExpense] }
      })
      saveGroups(get().pubkey, groups)
      return { groups, toast: `"${expense.description}" — ${expense.amount.toLocaleString()} sats` }
    })
  },

  // ─── SETTLEMENTS ───────────────────────────────────────────────────────────

  recordSettlement: async (groupRef, { from, to, amount, method = 'manual', walletReported = false }) => {
    const { pubkey } = get()
    const group = get().getGroup(groupRef)
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
      ['g', group.id], ['a', groupAddress(group)], ['p', to], ['t', 'splitsats'],
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
      ['g', group.id], ['a', groupAddress(group)], ['e', settlement._eventId], ['p', settlement.from], ['t', 'splitsats'],
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