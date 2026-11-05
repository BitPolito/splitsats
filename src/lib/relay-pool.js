// Minimal NIP-01 relay transport. A send() is not publication: only NIP-20
// ['OK', eventId, true, message] proves that a relay accepted an event.
// Acceptance is NOT proof that a payment happened or that every relay stored it.

export class RelayPool {
  constructor({ socketFactory = url => new WebSocket(url), verifyEvent = () => false,
    publishTimeoutMs = 12000, reconnectMaxMs = 30000 } = {}) {
    this._socketFactory = socketFactory
    this._verifyEvent = verifyEvent
    this._publishTimeoutMs = publishTimeoutMs
    this._reconnectMaxMs = reconnectMaxMs
    this._sockets = {}
    this._subs = {}
    this._seen = new Set()
    this._retries = {}
    this._reconnectTimers = {}
    this._knownRelays = new Set()
    this._pending = new Map()
    this._stopped = false
  }

  connect(url) {
    if (this._stopped) return
    this._knownRelays.add(url)
    const existing = this._sockets[url]
    if (existing && (existing.readyState === 0 || existing.readyState === 1)) return
    if (this._reconnectTimers[url]) {
      clearTimeout(this._reconnectTimers[url])
      delete this._reconnectTimers[url]
    }

    let ws
    try { ws = this._socketFactory(url) } catch {
      this._scheduleReconnect(url)
      return
    }
    this._sockets[url] = ws
    ws.onopen = () => {
      if (this._stopped || this._sockets[url] !== ws) return
      this._retries[url] = 0
      for (const [id, sub] of Object.entries(this._subs)) {
        // A reconnected relay begins a NEW observation epoch. This never
        // changes the existing first-EOSE application behavior.
        try { sub.onRelayReset?.(url, 'connected') } catch {}
        this._sendTo(ws, ['REQ', id, ...sub.filters])
      }
      // Retry the *same signed ID* after reconnect, never sign a new event.
      for (const entry of this._pending.values()) {
        if (!entry.responses.has(url)) this._sendTo(ws, ['EVENT', entry.event])
      }
    }
    ws.onmessage = e => {
      if (this._stopped || this._sockets[url] !== ws) return
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (!Array.isArray(msg)) return
      if (msg[0] === 'OK') {
        const [, eventId, accepted, description] = msg
        const entry = this._pending.get(eventId)
        if (!entry || typeof accepted !== 'boolean' || entry.responses.has(url)) return
        entry.responses.set(url, { accepted, description })
        if (accepted) {
          this._finishPublication(eventId, null, { relay: url })
        } else if ([...this._knownRelays].every(relay => entry.responses.get(relay)?.accepted === false)) {
          const reason = typeof description === 'string' ? `: ${description.slice(0, 160)}` : ''
          this._finishPublication(eventId, new Error(`Tutti i relay hanno rifiutato l'evento${reason}`))
        }
      } else if (msg[0] === 'EVENT') {
        const [, subId, event] = msg
        if (!event?.id || !this._subs[subId]) return
        const key = `${subId}:${event.id}`
        // Cryptographic signature validation precedes BOTH callbacks.
        try { if (!this._verifyEvent(event)) return } catch { return }
        // Audit every relay separately, even when the application has already
        // deduplicated this signed ID from a different relay.
        try { this._subs[subId]?.onRelayEvent?.(event, url) } catch {}
        if (this._seen.has(key)) return
        this._seen.add(key)
        this._subs[subId]?.onEvent(event)
      } else if (msg[0] === 'EOSE') {
        const sub = this._subs[msg[1]]
        // The first responding relay completes the initial load. Other relays
        // keep streaming later events, even if one relay is offline.
        if (sub) {
          // Every source gets its own EOSE callback, independent of the
          // legacy app callback which still fires on the FIRST relay only.
          try { sub.onRelayEose?.(url) } catch {}
          if (!sub.didEose) {
            sub.didEose = true
            sub.onEose?.()
          }
        }
      }
    }
    ws.onerror = () => {} // onclose handles retry; publish has a deadline
    ws.onclose = () => {
      if (this._stopped || this._sockets[url] !== ws) return
      delete this._sockets[url]
      for (const sub of Object.values(this._subs)) {
        try { sub.onRelayReset?.(url, 'disconnected') } catch {}
      }
      this._scheduleReconnect(url)
    }
  }

  _scheduleReconnect(url) {
    if (this._stopped || this._reconnectTimers[url]) return
    const retry = this._retries[url] || 0
    this._retries[url] = retry + 1
    const delay = Math.min(1000 * (2 ** Math.min(retry, 12)), this._reconnectMaxMs)
    this._reconnectTimers[url] = setTimeout(() => {
      delete this._reconnectTimers[url]
      this.connect(url)
    }, delay)
  }

  _sendTo(ws, message) {
    if (ws.readyState !== 1) return
    try { ws.send(JSON.stringify(message)) } catch { /* reconnect or timeout */ }
  }

  _broadcast(message) {
    Object.values(this._sockets).forEach(ws => this._sendTo(ws, message))
  }

  publish(event) {
    if (this._stopped) return Promise.reject(new Error('Connessione relay terminata'))
    if (!event || !/^[0-9a-f]{64}$/.test(event.id || '')) {
      return Promise.reject(new Error('Evento Nostr privo di identificativo valido'))
    }
    if (this._pending.has(event.id)) return this._pending.get(event.id).promise

    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    const entry = { event, responses: new Map(), promise, resolve, reject, timeout: null }
    this._pending.set(event.id, entry)
    entry.timeout = setTimeout(() => {
      const unknown = new Error('Nessun relay ha confermato la pubblicazione. Esito incerto: verifica la sincronizzazione prima di riprovare.')
      unknown.code = 'RELAY_PUBLICATION_UNKNOWN'
      this._finishPublication(event.id, unknown)
    }, this._publishTimeoutMs)
    this._broadcast(['EVENT', event])
    return promise
  }

  _finishPublication(eventId, error, result) {
    const entry = this._pending.get(eventId)
    if (!entry) return
    clearTimeout(entry.timeout)
    this._pending.delete(eventId)
    if (error) entry.reject(error)
    else entry.resolve(result)
  }

  subscribe({ id, filters, onEvent, onEose, onRelayEvent, onRelayEose, onRelayReset }) {
    const subId = id || Math.random().toString(36).slice(2)
    if (this._subs[subId]) this.unsubscribe(subId)
    this._subs[subId] = { filters, onEvent, onEose, onRelayEvent, onRelayEose, onRelayReset, didEose: false }
    this._broadcast(['REQ', subId, ...filters])
    return () => this.unsubscribe(subId)
  }

  unsubscribe(subId) {
    delete this._subs[subId]
    for (const key of this._seen) {
      if (key.startsWith(`${subId}:`)) this._seen.delete(key)
    }
    this._broadcast(['CLOSE', subId])
  }

  get connectedCount() {
    return Object.values(this._sockets).filter(ws => ws.readyState === 1).length
  }

  // Primarily for teardown and isolated unit tests.
  stop() {
    this._stopped = true
    Object.values(this._reconnectTimers).forEach(clearTimeout)
    this._reconnectTimers = {}
    for (const id of this._pending.keys()) {
      this._finishPublication(id, new Error('Connessione relay terminata'))
    }
    Object.values(this._sockets).forEach(ws => { try { ws.close() } catch {} })
    this._sockets = {}
    this._subs = {}
    this._seen.clear()
  }
}
