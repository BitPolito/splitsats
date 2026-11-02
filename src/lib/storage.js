// Local cache is scoped to the currently authenticated Nostr account.
// This is a convenience cache, NOT a private/encrypted store. Event payloads
// published to public relays may be visible to anyone.

const KEY_PUBKEY = 'splitsats:pubkey'
const LEGACY_GROUPS = 'splitsats:groups'
const LEGACY_PROFILES = 'splitsats:profiles'
const VALID_KEY = /^[0-9a-f]{64}$/

function cacheKey(kind, pubkey) {
  return VALID_KEY.test(pubkey || '') ? `splitsats:${kind}:v2:${pubkey}` : null
}

function readJson(raw, fallback, valid) {
  if (raw === null) return fallback
  try {
    const parsed = JSON.parse(raw)
    return valid(parsed) ? parsed : fallback
  } catch { return fallback }
}

const validGroups = value => Array.isArray(value)
const validProfiles = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function loadPubkey() {
  try { return readJson(localStorage.getItem(KEY_PUBKEY), null, value => VALID_KEY.test(value || '')) }
  catch { return null }
}

export function savePubkey(pubkey) {
  if (!VALID_KEY.test(pubkey || '')) throw new Error('Chiave Nostr non valida')
  localStorage.setItem(KEY_PUBKEY, JSON.stringify(pubkey))
}

export function clearPubkey() {
  try { localStorage.removeItem(KEY_PUBKEY) } catch {}
}

function loadScoped(kind, pubkey, legacyKey, fallback, valid) {
  const key = cacheKey(kind, pubkey)
  if (!key) return fallback
  try {
    const scoped = localStorage.getItem(key)
    if (scoped !== null) return readJson(scoped, fallback, valid)

    // Migrate legacy data ONLY to the account that owned it. Other accounts
    // must never receive data cached under a previous Nostr signer.
    if (loadPubkey() !== pubkey) return fallback
    const legacy = localStorage.getItem(legacyKey)
    if (legacy === null) return fallback
    const value = readJson(legacy, fallback, valid)
    if (!valid(value)) return fallback
    try {
      localStorage.setItem(key, JSON.stringify(value))
      localStorage.removeItem(legacyKey)
    } catch { /* Retain legacy data for the original account if quota is full. */ }
    return value
  } catch { return fallback }
}

function saveScoped(kind, pubkey, data, valid) {
  const key = cacheKey(kind, pubkey)
  if (!key || !valid(data)) throw new Error('Cache Nostr non valida')
  try { localStorage.setItem(key, JSON.stringify(data)) }
  catch { /* Cache is optional; relay remains source of truth. */ }
}

export const loadGroups = pubkey => loadScoped('groups', pubkey, LEGACY_GROUPS, [], validGroups)
export const saveGroups = (pubkey, groups) => saveScoped('groups', pubkey, groups, validGroups)
export const loadProfiles = pubkey => loadScoped('profiles', pubkey, LEGACY_PROFILES, {}, validProfiles)
export const saveProfiles = (pubkey, profiles) => saveScoped('profiles', pubkey, profiles, validProfiles)

// Logout clears cached data for this account (but NEVER the separately scoped,
// already-signed outbox: its events must remain recoverable after logging back in).
export function clearAll(pubkey) {
  try {
    for (const kind of ['groups', 'profiles']) {
      const key = cacheKey(kind, pubkey)
      if (key) localStorage.removeItem(key)
    }
    localStorage.removeItem(LEGACY_GROUPS)
    localStorage.removeItem(LEGACY_PROFILES)
  } catch {}
  clearPubkey()
}
