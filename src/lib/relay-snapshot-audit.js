// Phase 2E-D-A: conservative per-relay snapshot observation for signed Nostr events.
// The caller MUST feed events only after RelayPool.verifyEvent has succeeded.
// Matching snapshots do not establish relay completeness, finality or payment proof.
const HEX = /^[0-9a-f]{64}$/
export const MAX_AUDIT_IDS_PER_RELAY = 500

function eventIdentity(event) {
  if (!HEX.test(event?.id || '') || !HEX.test(event?.pubkey || '') ||
      !Number.isSafeInteger(event?.kind) || !Number.isSafeInteger(event?.created_at) ||
      typeof event.content !== 'string' || !Array.isArray(event.tags)) return null
  // Only immutable, signed Nostr envelope fields: never use local metadata.
  return JSON.stringify([event.id, event.pubkey, event.kind,
    event.created_at, event.content, event.tags, event.sig])
}

export class RelaySnapshotAudit {
  constructor(relays) {
    if (!Array.isArray(relays) || !relays.length ||
        relays.some(url => typeof url !== 'string' || !url.startsWith('wss://')) ||
        new Set(relays).size !== relays.length) {
      throw new Error('Configurazione audit relay non valida')
    }
    this.relays = new Map(relays.map(relay => [relay, {
      relay, epoch: 0, phase: 'loading', eose: false, ids: new Map(),
      overflow: false, saturated: false, late: false, conflict: false,
    }]))
  }

  reset(relay, reason = 'connected') {
    const row = this.relays.get(relay)
    if (!row) return false
    row.epoch++
    row.phase = reason === 'disconnected' ? 'offline' : 'loading'
    row.eose = false
    row.ids.clear()
    // Sticky security flags: a truncated/contradictory snapshot cannot be
    // silently called complete after one reconnect.
    row.late = false
    return true
  }

  record(relay, event) {
    const row = this.relays.get(relay)
    if (!row || row.phase === 'offline') return false
    const identity = eventIdentity(event)
    if (!identity) { row.conflict = true; return false }
    const previous = row.ids.get(event.id)
    if (previous) {
      if (previous !== identity) row.conflict = true
      return false
    }
    if (row.ids.size >= MAX_AUDIT_IDS_PER_RELAY) {
      row.overflow = true
      return false
    }
    if (row.eose) row.late = true
    row.ids.set(event.id, identity)
    if (row.ids.size === MAX_AUDIT_IDS_PER_RELAY) row.saturated = true
    return true
  }

  eose(relay) {
    const row = this.relays.get(relay)
    if (!row || row.phase === 'offline') return false
    row.eose = true
    row.phase = 'eose'
    return true
  }

  report() {
    const rows = [...this.relays.values()]
    const completed = rows.filter(r => r.eose && r.phase === 'eose')
    const base = completed[0]?.ids || null
    const mismatch = completed.some(r => {
      if (!base || r.ids.size !== base.size) return true
      for (const [id, fingerprint] of base) {
        if (r.ids.get(id) !== fingerprint) return true
      }
      return false
    })
    const overflow = rows.some(r => r.overflow)
    const saturated = rows.some(r => r.saturated)
    const conflict = rows.some(r => r.conflict)
    const late = rows.some(r => r.late)
    const allEose = completed.length === rows.length
    const status = conflict ? 'conflict' : overflow ? 'overflow' : saturated ? 'at-limit' : late ? 'changed-after-eose' :
      mismatch ? 'divergent' : allEose && rows.length >= 2 ? 'matching-observed' : 'pending'
    return Object.freeze({
      status, configuredRelays: rows.length, completedRelays: completed.length,
      allEose, comparable: completed.length >= 2,
      safeForPayments: false, completeHistory: false,
      relays: rows.map(r => ({ relay: r.relay, phase: r.phase, epoch: r.epoch,
        eose: r.eose, eventCount: r.ids.size, overflow: r.overflow, saturated: r.saturated,
        lateEvents: r.late, conflict: r.conflict })),
    })
  }
}
