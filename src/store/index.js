import { create } from 'zustand'
import { loadGroups, saveGroups, loadProfiles, saveProfiles, loadPubkey, savePubkey, clearAll } from '../lib/storage'
import { publishEvent, fetchProfile, fetchGroups, subscribeExpenses, subscribeSettlements, pool, npubToHex } from '../lib/nostr'
import { KIND_GROUP, KIND_EXPENSE, KIND_SETTLEMENT } from '../lib/constants'

const randId = () => Math.random().toString(36).slice(2, 10)
const now    = () => Math.floor(Date.now() / 1000)

const activeSubs = {}
let currentSessionPubkey = null

function stopActiveSubscriptions() {
  Object.values(activeSubs).forEach(unsub => { try { unsub() } catch {} })
  Object.keys(activeSubs).forEach(key => delete activeSubs[key])
  currentSessionPubkey = null
}

export const useStore = create((set, get) => ({
  pubkey:      loadPubkey(),   // always hex
  loading:     false,
  error:       null,
  groups:      loadGroups(),
  profiles:    loadProfiles(),
  relayStatus: 0,
  toast:       null,

  getGroup: (id) => get().groups.find(g => g.id === id),

  // ─── AUTH ──────────────────────────────────────────────────────────────────

  login: async () => {
    set({ loading: true, error: null })
    try {
      // NIP-07 always returns hex pubkey
      const pubkey = await window.nostr.getPublicKey()
      savePubkey(pubkey)
      set({ pubkey, loading: false })
    } catch (e) {
      set({ error: e.message, loading: false })
    }
  },

  logout: () => {
    stopActiveSubscriptions()
    clearAll()
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
      if (g.members?.length) {
        get().subscribeGroup(g.id, g.members)
        g.members.forEach(m => get().fetchAndCacheProfile(m))
      }
    })

    // Then fetch from relay — may return new groups or updates
    const seenGroupIds = new Set(cachedGroups.map(g => g.id))

    activeSubs['_groups'] = fetchGroups(
      pubkey,
      (groupData) => {
        const alreadyCached = seenGroupIds.has(groupData.id)
        seenGroupIds.add(groupData.id)

        if (!alreadyCached) {
          // New group not in cache
          const newGroup = { ...groupData, expenses: [], settlements: [], _synced: false }
          set(s => {
            const updated = [...s.groups, newGroup]
            saveGroups(updated)
            return { groups: updated }
          })
          get().subscribeGroup(groupData.id, groupData.members || [pubkey])
          ;(groupData.members || []).forEach(m => get().fetchAndCacheProfile(m))
        } else {
          // Group exists — update metadata (name/members may have changed)
          set(s => {
            const groups = s.groups.map(g =>
              g.id === groupData.id
                ? { ...g, name: groupData.name, members: groupData.members }
                : g
            )
            saveGroups(groups)
            return { groups }
          })
        }
      },
      () => {
        set(s => {
          const groups = s.groups.map(g => ({ ...g, _synced: true }))
          saveGroups(groups)
          return { groups }
        })
      }
    )
  },

  // ─── REAL-TIME SUBSCRIPTIONS ───────────────────────────────────────────────

  subscribeGroup: (groupId, members) => {
    if (activeSubs['exp_' + groupId]) return // already subscribed

    const unsubExp = subscribeExpenses(
      groupId, members,
      (expense) => {
        set(s => {
          const groups = s.groups.map(g => {
            if (g.id !== groupId) return g
            if (g.expenses.find(e => e.id === expense.id)) return g
            return { ...g, expenses: [...g.expenses, expense] }
          })
          saveGroups(groups)
          return { groups }
        })
      },
      () => {}
    )

    const unsubSet = subscribeSettlements(
      groupId, members,
      (settlement) => {
        set(s => {
          const groups = s.groups.map(g => {
            if (g.id !== groupId) return g
            if ((g.settlements || []).some(s =>
              s._eventId === settlement._eventId || (s.id && settlement.id && s.id === settlement.id)
            )) return g
            return { ...g, settlements: [...(g.settlements || []), settlement] }
          })
          saveGroups(groups)
          return { groups }
        })
      },
      () => {}
    )

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
    activeSubs[subKey] = fetchProfile(hexPubkey, (pk, meta) => {
      set(s => {
        const updated = { ...s.profiles, [pk]: meta }
        saveProfiles(updated)
        return { profiles: updated }
      })
    })
  },

  // ─── GROUPS ────────────────────────────────────────────────────────────────

  createGroup: async ({ name, members }) => {
    const { pubkey } = get()
    // members are already hex (validated in CreateGroupModal)
    const groupId   = randId()
    const groupData = { id: groupId, name, members, createdAt: now() }

    await publishEvent(pubkey, KIND_GROUP, groupData, [
      ['d', groupId],
      ['t', 'splitsats'],
      ...members.map(m => ['p', m]),
    ])

    const newGroup = { ...groupData, expenses: [], settlements: [], _synced: true }
    set(s => {
      const updated = [...s.groups, newGroup]
      saveGroups(updated)
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
    if (!group) return

    const expenseData = { ...expense, id: randId(), createdAt: now() }

    const signed = await publishEvent(pubkey, KIND_EXPENSE, expenseData, [
      ['g', groupId],
      ['t', 'splitsats'],
      ...group.members.map(m => ['p', m]),
    ])

    const localExpense = { ...expenseData, _eventId: signed.id, _pubkey: pubkey }
    set(s => {
      const groups = s.groups.map(g => {
        if (g.id !== groupId) return g
        if (g.expenses.some(e => e.id === expenseData.id || e._eventId === signed.id)) return g
        return { ...g, expenses: [...g.expenses, localExpense] }
      })
      saveGroups(groups)
      return { groups, toast: `"${expense.description}" — ${expense.amount.toLocaleString()} sats` }
    })
  },

  // ─── SETTLEMENTS ───────────────────────────────────────────────────────────

  recordSettlement: async (groupId, { from, to, amount }) => {
    const { pubkey } = get()
    const data = { id: randId(), from, to, amount, settledAt: now() }

    const signed = await publishEvent(pubkey, KIND_SETTLEMENT, data, [
      ['g', groupId],
      ['p', to],
      ['t', 'splitsats'],
    ])

    const localSettlement = { ...data, _eventId: signed.id }
    set(s => {
      const groups = s.groups.map(g => {
        if (g.id !== groupId) return g
        const settlements = g.settlements || []
        if (settlements.some(s => s._eventId === signed.id || s.id === data.id)) return g
        return { ...g, settlements: [...settlements, localSettlement] }
      })
      saveGroups(groups)
      return { groups, toast: `Pagamento di ${amount.toLocaleString()} sats registrato` }
    })
  },

  // ─── TOAST ─────────────────────────────────────────────────────────────────

  clearToast: () => set({ toast: null }),
  showToast:  (msg) => set({ toast: msg }),
}))