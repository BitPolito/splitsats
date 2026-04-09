// ─── LocalStorage persistence ─────────────────────────────────────────────────
// Acts as a local cache — relay is the source of truth,
// but we persist locally so data survives page reloads.

const KEY_GROUPS    = 'splitsats:groups'
const KEY_PROFILES  = 'splitsats:profiles'
const KEY_PUBKEY    = 'splitsats:pubkey'

function safeGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch { return fallback }
}

function safeSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
}

// ── Groups ──
export const loadGroups  = ()            => safeGet(KEY_GROUPS, [])
export const saveGroups  = (groups)      => safeSet(KEY_GROUPS, groups)

// ── Profiles ──
export const loadProfiles  = ()          => safeGet(KEY_PROFILES, {})
export const saveProfiles  = (profiles)  => safeSet(KEY_PROFILES, profiles)

// ── Last logged-in pubkey (for auto-login hint) ──
export const loadPubkey  = ()            => safeGet(KEY_PUBKEY, null)
export const savePubkey  = (pk)          => safeSet(KEY_PUBKEY, pk)
export const clearPubkey = ()            => localStorage.removeItem(KEY_PUBKEY)

// ── Full reset ──
export function clearAll() {
  ;[KEY_GROUPS, KEY_PROFILES, KEY_PUBKEY].forEach(k => localStorage.removeItem(k))
}
