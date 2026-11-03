import { create } from 'zustand'
import { loadGroups, saveGroups, loadProfiles, saveProfiles, loadPubkey, savePubkey, clearAll, clearPubkey } from '../lib/storage'
import { verifyCachedSigner } from '../lib/session-identity'
import { publishEvent, fetchProfile, fetchGroups, subscribeExpenses, subscribeSettlements, subscribeConfirmations, pool, npubToHex } from '../lib/nostr'
import { KIND_GROUP, KIND_EXPENSE, KIND_SETTLEMENT, KIND_CONFIRMATION } from '../lib/constants'
import { isNewerGroupDefinition, validPubkey } from '../lib/event-validation'
import { groupAddress } from '../lib/group-history'
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

  getGroup: (id) => get().groups.find(g => g.id === id),

  // ─── AUTH ──────────────────────────────────────────────────────────────────

  restoreSession: async () => {
    if (get().pubkey) return
    const cached = loadPubkey()
    if (!cached) return
    const active = await verifyCachedSigner(cached, typeof window !== 'undefined' && window.nostr)
    // A user might have logged in manually while the signer prompt was open.
    if (get().pubkey) return
    if (active) set({ pubkey: active, groups: loadGroups(active), profiles: loadProfiles(active) })
    else clearPubkey()
  },

  login: async () => {
    set({ loading: true, error: null })
    try {
      // NIP-07 always returns hex pubkey
      const pubkey = await window.nostr.getPublicKey()
      // Read/migrate legacy cache under its original owner BEFORE switching the hint.
      const groups = loadGroups(pubkey)
      const profiles = loadProfiles(pubkey)
      stopActiveSubscriptions()
      savePubkey(pubkey)
      set({ pubkey, groups, profiles, loading: false })
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

    // FIX: subscribe cached groups immediately on startup (page reload case)
    const cachedGroups = get().groups
    cachedGroups.forEach(g => {
      if (g.members?.includes(pubkey)) {
        get().subscribeGroup(g.id, g.members)
        g.members.forEach(m => get().fetchAndCacheProfile(m))
      }
    })

    // Relay order is not canonical: groups are NIP-33 addressable events.
    activeSubs['_groups'] = fetchGroups(
      pubkey,
      (groupData) => {
        if (currentSessionPubkey !== pubkey) return
        const existing = get().getGroup(groupData.id)
        if (!isNewerGroupDefinition(existing, groupData)) return
        const updatedGroup = existing
          ? { ...existing, ...groupData, expenses: existing.expenses || [], settlements: existing.settlements || [], confirmations: existing.confirmations || [] }
          : { ...groupData, expenses: [], settlements: [], confirmations: [], _synced: false }
        set(s => {
          const groups = existing
            ? s.groups.map(g => g.id === groupData.id ? updatedGroup : g)
            : [...s.groups, updatedGroup]
          saveGroups(get().pubkey, groups)
          return { groups }
        })
        // Important: membership changes affect which authors are queried.
        get().subscribeGroup(groupData.id, groupData.members)
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

  subscribeGroup: (groupId, members) => {
    const subscriptionOwner = get().pubkey
    const groupOwner = get().getGroup(groupId)?.pubkey || null
    const memberKey = `${groupOwner || 'legacy'}:${[...new Set(members)].sort().join(',')}`
    if (activeSubs['exp_' + groupId] && subscribedMemberKeys[groupId] === memberKey) return
    // Close old subscriptions before replacing author filters with the new members.
    activeSubs['exp_' + groupId]?.()
    activeSubs['set_' + groupId]?.()
    activeSubs['conf_' + groupId]?.()
    subscribedMemberKeys[groupId] = memberKey

    const unsubExp = subscribeExpenses(
      groupId, members,
      (expense) => {
        if (get().pubkey !== subscriptionOwner || currentSessionPubkey !== subscriptionOwner) return
        set(s => {
          const groups = s.groups.map(g => {
            if (g.id !== groupId) return g
            // A callback from a closed subscription must not admit a removed member.
            if (!g.members.includes(expense._pubkey) || !g.members.includes(expense.paidBy) ||
                !expense.splits.every(m => g.members.includes(m))) return g
            if (g.expenses.some(e => e._eventId === expense._eventId ||
              (e.id === expense.id && e._pubkey === expense._pubkey))) return g
            return { ...g, expenses: [...g.expenses, expense] }
          })
          saveGroups(get().pubkey, groups)
          return { groups }
        })
      },
      () => {}, groupOwner
    )

    const unsubSet = subscribeSettlements(
      groupId, members,
      (settlement) => {
        if (get().pubkey !== subscriptionOwner || currentSessionPubkey !== subscriptionOwner) return
        set(s => {
          const groups = s.groups.map(g => {
            if (g.id !== groupId) return g
            if (!g.members.includes(settlement._pubkey) || settlement._pubkey !== settlement.from ||
                !g.members.includes(settlement.to)) return g
            if ((g.settlements || []).some(s =>
              s._eventId === settlement._eventId ||
              (s.id && settlement.id && s.id === settlement.id && s._pubkey === settlement._pubkey)
            )) return g
            return { ...g, settlements: [...(g.settlements || []), settlement] }
          })
          saveGroups(get().pubkey, groups)
          return { groups }
        })
      },
      () => {}, groupOwner
    )

    const unsubConf = subscribeConfirmations(
      groupId, members,
      (confirmation) => {
        if (get().pubkey !== subscriptionOwner || currentSessionPubkey !== subscriptionOwner) return
        set(s => {
          const groups = s.groups.map(g => {
            if (g.id !== groupId || !g.members.includes(confirmation._pubkey) ||
                !g.members.includes(confirmation.from) || !g.members.includes(confirmation.to)) return g
            const confirmations = g.confirmations || []
            if (confirmations.some(c => c._eventId === confirmation._eventId)) return g
            return { ...g, confirmations: [...confirmations, confirmation] }
          })
          saveGroups(get().pubkey, groups)
          return { groups }
        })
        // This callback receives an event verified by the relay pool, not an
        // untrusted cached snapshot. A wallet lock is released only when the
        // recipient's signed confirmation references the exact local claim.
        if (confirmation.from === subscriptionOwner) {
          const settlement = get().getGroup(groupId)?.settlements?.find(s =>
            s._eventId === confirmation.settlementEventId && s.from === confirmation.from &&
            s.to === confirmation.to && s.amount === confirmation.amount)
          if (settlement) {
            try {
              releaseConfirmedPaymentAttempt(
                { account: subscriptionOwner, groupId, to: settlement.to }, settlement._eventId)
            } catch { /* Keep the safety lock on any storage error. */ }
          }
        }
      },
      () => {}, groupOwner
    )

    activeSubs['conf_' + groupId] = unsubConf
    activeSubs['exp_' + groupId] = unsubExp
    activeSubs['set_' + groupId] = unsubSet
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
      const updated = [...s.groups, newGroup]
      saveGroups(get().pubkey, updated)
      return { groups: updated, toast: `Gruppo "${name}" creato` }
    })

    get().subscribeGroup(groupId, members)
    members.forEach(m => get().fetchAndCacheProfile(m))
    return groupId
  },

  // ─── EXPENSES ──────────────────────────────────────────────────────────────

  addExpense: async (groupId, expense) => {
    const { pubkey } = get()
    const group      = get().getGroup(groupId)
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
      ['g', groupId], ['a', groupAddress(group)],
      ['t', 'splitsats'],
      ...group.members.map(m => ['p', m]),
    ])

    if (get().pubkey !== pubkey) return // keep event associated with its signing account

    const localExpense = { ...expenseData, _eventId: signed.id, _pubkey: pubkey }
    set(s => {
      const groups = s.groups.map(g => {
        if (g.id !== groupId) return g
        if (g.expenses.some(e => e._eventId === signed.id ||
          (e.id === expenseData.id && e._pubkey === pubkey))) return g
        return { ...g, expenses: [...g.expenses, localExpense] }
      })
      saveGroups(get().pubkey, groups)
      return { groups, toast: `"${expense.description}" — ${expense.amount.toLocaleString()} sats` }
    })
  },

  // ─── SETTLEMENTS ───────────────────────────────────────────────────────────

  recordSettlement: async (groupId, { from, to, amount, method = 'manual', walletReported = false }) => {
    const { pubkey } = get()
    const group = get().getGroup(groupId)
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
      ['g', groupId], ['a', groupAddress(group)], ['p', to], ['t', 'splitsats'],
    ])

    if (get().pubkey !== pubkey) return

    const localSettlement = { ...data, _eventId: signed.id, _pubkey: pubkey }
    set(s => {
      const groups = s.groups.map(g => {
        if (g.id !== groupId) return g
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

  confirmSettlement: async (groupId, settlementId) => {
    const { pubkey } = get()
    const group = get().getGroup(groupId)
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
      ['g', groupId], ['a', groupAddress(group)], ['e', settlement._eventId], ['p', settlement.from], ['t', 'splitsats'],
    ])
    if (get().pubkey !== pubkey) return
    const confirmation = { ...data, _eventId: signed.id, _pubkey: pubkey }
    set(s => {
      const groups = s.groups.map(g => {
        if (g.id !== groupId) return g
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