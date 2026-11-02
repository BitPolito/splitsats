// Durable, account-scoped queue of already-signed Nostr events.
// Signatures are public information. Never persist wallet secrets or private keys here.
const HEX_KEY = /^[0-9a-f]{64}$/
const HEX_SIG = /^[0-9a-f]{128}$/
const PREFIX = 'splitsats:outbox:v1:'
const MAX_EVENTS = 64
const MAX_EVENT_BYTES = 32768

function outboxError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function eventScope(event) {
  // A pending write must not be re-created with a new signature and ID.
  // Group creation has a new group ID each time: block *all* pending group creations.
  if (event.kind === 30001) return '30001:all-pending-creations'
  const group = event.tags?.find(tag => Array.isArray(tag) && tag[0] === 'g')?.[1] || ''
  return `${event.kind}:${group}`
}

export class SignedEventOutbox {
  constructor({ storage, onChange } = {}) {
    this._storage = storage
    this._listeners = new Set()
    if (onChange) this._listeners.add(onChange)
  }

  _getStorage() {
    try {
      const storage = this._storage || (typeof localStorage !== 'undefined' && localStorage)
      if (!storage) throw new Error('missing localStorage')
      return storage
    } catch {
      throw outboxError('OUTBOX_STORAGE_UNAVAILABLE', 'Salvataggio locale non disponibile. Evento non inviato.')
    }
  }

  _key(pubkey) {
    if (!HEX_KEY.test(pubkey || '')) throw outboxError('OUTBOX_INVALID_EVENT', 'Chiave Nostr non valida')
    return PREFIX + pubkey
  }

  _read(pubkey) {
    const storage = this._getStorage()
    try {
      const raw = storage.getItem(this._key(pubkey))
      if (raw === null) return []
      const entries = JSON.parse(raw)
      if (!Array.isArray(entries) || entries.length > MAX_EVENTS ||
          !entries.every(row => row && HEX_KEY.test(row.event?.id || '') &&
            row.event.pubkey === pubkey && HEX_SIG.test(row.event.sig || '') &&
            Number.isFinite(row.queuedAt))) throw new Error('invalid outbox')
      return entries
    } catch {
      // Never silently overwrite pending events if the cache is corrupt.
      throw outboxError('OUTBOX_DATA_ERROR', 'Outbox locale danneggiata o illeggibile: non inviare nuovi eventi.')
    }
  }

  list(pubkey) {
    // JSON-decoded copies; callers cannot mutate an existing persisted event.
    return this._read(pubkey)
  }

  hasConflict(event) {
    return this._read(event.pubkey).some(row =>
      row.event.id !== event.id && eventScope(row.event) === eventScope(event))
  }

  add(event) {
    if (!event || !HEX_KEY.test(event.id || '') || !HEX_KEY.test(event.pubkey || '') ||
        !HEX_SIG.test(event.sig || '') || !Array.isArray(event.tags) ||
        !Number.isSafeInteger(event.kind) || typeof event.content !== 'string' ||
        !Number.isSafeInteger(event.created_at)) {
      throw outboxError('OUTBOX_INVALID_EVENT', 'Evento Nostr firmato non valido')
    }
    const encoded = JSON.stringify(event)
    if (encoded.length > MAX_EVENT_BYTES) throw outboxError('OUTBOX_INVALID_EVENT', 'Evento Nostr troppo grande')
    const rows = this._read(event.pubkey)
    const existing = rows.find(row => row.event.id === event.id)
    if (existing) {
      if (JSON.stringify(existing.event) !== encoded) throw outboxError('OUTBOX_INVALID_EVENT', 'Evento con ID duplicato ma contenuto differente')
      return
    }
    if (this.hasConflict(event)) {
      throw outboxError('OUTBOX_PENDING', 'Esiste già un evento da sincronizzare per questa operazione. Usa RIPROVA OUTBOX, non creare un duplicato.')
    }
    if (rows.length >= MAX_EVENTS) throw outboxError('OUTBOX_FULL', 'Outbox piena: sincronizza gli eventi prima di continuare.')
    rows.push({ event, queuedAt: Date.now() })
    this._write(event.pubkey, rows)
  }

  _write(pubkey, rows) {
    try {
      this._getStorage().setItem(this._key(pubkey), JSON.stringify(rows))
    } catch {
      throw outboxError('OUTBOX_STORAGE_UNAVAILABLE', 'Impossibile salvare l’evento. Nulla è stato inviato.')
    }
    this._notify(pubkey)
  }

  remove(pubkey, eventId) {
    const rows = this._read(pubkey)
    if (!rows.some(row => row.event.id === eventId)) return false
    this._write(pubkey, rows.filter(row => row.event.id !== eventId))
    return true
  }

  subscribe(listener) {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  _notify(pubkey) {
    for (const listener of this._listeners) {
      try { listener(pubkey) } catch { /* observers cannot break persistence */ }
    }
  }
}

export const outbox = new SignedEventOutbox()

// Injectable replay routine, deliberately independent of the browser and signer.
// Always verify identity and stored signatures BEFORE network activity.
export async function replayStoredEvents({ pubkey, activePubkey, store, publish, verify }) {
  if (pubkey !== activePubkey) throw outboxError('OUTBOX_ACCOUNT_MISMATCH', 'Il signer Nostr non corrisponde all’account della outbox')
  const entries = store.list(pubkey)
  const results = []
  for (const { event } of entries) {
    let valid = false
    try { valid = event.pubkey === pubkey && verify(event) } catch { valid = false }
    if (!valid) {
      results.push({ id: event.id, ok: false, error: 'Firma non valida: evento non inviato' })
      continue
    }
    try {
      await publish(event)
      // The network ACK may have arrived even if local cleanup fails.
      try { store.remove(pubkey, event.id) } catch {
        results.push({ id: event.id, ok: false, error: 'Relay OK; pulizia locale fallita. Ritentare lo stesso ID, senza creare duplicati.' })
        continue
      }
      results.push({ id: event.id, ok: true })
    } catch (error) {
      results.push({ id: event.id, ok: false, error: error?.message || 'Pubblicazione non confermata' })
    }
  }
  return results
}
