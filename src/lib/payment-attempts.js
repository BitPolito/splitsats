// Durable, account-scoped guard for WebLN submissions. A relay ACK does NOT
// settle a Lightning invoice, and localStorage is not a payment authority.
// We deliberately never store invoices, preimages, or private keys here.

const PREFIX = 'splitsats:webln-attempt:v1:'
const PUBKEY = /^[a-f0-9]{64}$/
const EVENT_ID = /^[a-f0-9]{64}$/
const STATES = new Set(['submitted', 'outcome-unknown', 'wallet-reported', 'claim-pending'])

function failure(message, code = 'PAYMENT_ATTEMPT_STORAGE_ERROR') {
  const error = new Error(message)
  error.code = code
  return error
}

function attemptKey({ account, groupId, to }) {
  if (!PUBKEY.test(account || '') || !PUBKEY.test(to || '') ||
      typeof groupId !== 'string' || !groupId || groupId.length > 200) {
    throw failure('Identità del tentativo Lightning non valida', 'PAYMENT_ATTEMPT_INVALID')
  }
  return `${PREFIX}${account}:${encodeURIComponent(groupId)}:${to}`
}

function storage() {
  try {
    const store = globalThis.localStorage
    if (typeof store?.getItem !== 'function' || typeof store?.setItem !== 'function' ||
        typeof store?.removeItem !== 'function') throw new Error('Storage non disponibile')
    return store
  } catch {
    throw failure('Archivio tentativi Lightning non disponibile: nessun pagamento inviato')
  }
}

function validAttempt(value, scope) {
  return value && value.version === 1 && value.account === scope.account &&
    value.groupId === scope.groupId && value.to === scope.to &&
    Number.isSafeInteger(value.amount) && value.amount > 0 &&
    Number.isSafeInteger(value.startedAt) && value.startedAt > 0 &&
    STATES.has(value.status) &&
    (value.claimEventId === null || (typeof value.claimEventId === 'string' && EVENT_ID.test(value.claimEventId)))
}

// Where available, the browser's Web Locks serialize wallet submissions
// across same-origin tabs. This is not a cross-device or wallet-level lock.
export async function withPaymentOperationLock(scope, task) {
  const key = attemptKey(scope)
  if (typeof task !== 'function') throw failure('Operazione non valida', 'PAYMENT_ATTEMPT_INVALID')
  const locks = globalThis.navigator?.locks
  return typeof locks?.request === 'function'
    ? locks.request(key, { mode: 'exclusive' }, task)
    : task()
}

export function getPaymentAttempt(scope) {
  const key = attemptKey(scope)
  let raw
  try { raw = storage().getItem(key) }
  catch { throw failure('Impossibile leggere i tentativi Lightning: pagamento bloccato') }
  if (raw === null) return null
  try {
    const attempt = JSON.parse(raw)
    if (validAttempt(attempt, scope)) return attempt
  } catch { /* fail closed */ }
  throw failure('Archivio tentativi Lightning danneggiato: pagamento bloccato', 'PAYMENT_ATTEMPT_CORRUPT')
}

function writeAttempt(scope, attempt) {
  const key = attemptKey(scope)
  try {
    storage().setItem(key, JSON.stringify(attempt))
    const raw = storage().getItem(key)
    if (raw !== JSON.stringify(attempt)) throw Error('Verification failed')
  } catch {
    throw failure('Impossibile salvare il tentativo: pagamento bloccato')
  }
  return attempt
}

export function beginPaymentAttempt(scope, amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw failure('Importo Lightning non valido', 'PAYMENT_ATTEMPT_INVALID')
  }
  if (getPaymentAttempt(scope)) {
    throw failure('Un tentativo per questo destinatario è già presente: verifica il wallet prima di proseguire',
      'PAYMENT_ATTEMPT_PENDING')
  }
  const attempt = { version: 1, account: scope.account, groupId: scope.groupId,
    to: scope.to, amount, startedAt: Date.now(), status: 'submitted', claimEventId: null }
  return writeAttempt(scope, attempt)
}

export function updatePaymentAttempt(scope, nextStatus, { claimEventId = null } = {}) {
  const attempt = getPaymentAttempt(scope)
  if (!attempt) throw failure('Nessun tentativo Lightning da aggiornare', 'PAYMENT_ATTEMPT_INVALID')
  const allowed = {
    submitted: ['outcome-unknown', 'wallet-reported'],
    'outcome-unknown': ['claim-pending'],
    'wallet-reported': ['claim-pending'],
    'claim-pending': [],
  }
  if (!allowed[attempt.status].includes(nextStatus) ||
      (nextStatus === 'claim-pending' && !EVENT_ID.test(claimEventId || '')) ||
      (claimEventId !== null && (!EVENT_ID.test(claimEventId) || nextStatus !== 'claim-pending'))) {
    throw failure('Transizione del tentativo Lightning non valida', 'PAYMENT_ATTEMPT_INVALID')
  }
  return writeAttempt(scope, { ...attempt, status: nextStatus,
    claimEventId: nextStatus === 'claim-pending' ? claimEventId : null })
}

// Only a signed, recipient-confirmed settlement matching this exact event ID
// releases the local guard automatically. Never release just on wallet success.
export function releaseConfirmedPaymentAttempt(scope, settlementEventId) {
  const attempt = getPaymentAttempt(scope)
  if (!attempt || !attempt.claimEventId || attempt.claimEventId !== settlementEventId ||
      attempt.status !== 'claim-pending') return false
  try { storage().removeItem(attemptKey(scope)) }
  catch { throw failure('Non riesco a rimuovere il tentativo confermato') }
  return true
}

// Recovery is intentionally explicit. It must be used only after checking the
// wallet AND contacting the recipient: a timeout is never proof of non-payment.
export function releaseVerifiedUnpaidAttempt(scope, acknowledged) {
  if (acknowledged !== 'NESSUN PAGAMENTO') {
    throw failure('Conferma esplicita richiesta', 'PAYMENT_ATTEMPT_INVALID')
  }
  const attempt = getPaymentAttempt(scope)
  if (!attempt) return false
  if (attempt.status === 'claim-pending') {
    throw failure('Richiesta già pubblicata: attendi la conferma del destinatario', 'PAYMENT_ATTEMPT_INVALID')
  }
  try { storage().removeItem(attemptKey(scope)) }
  catch { throw failure('Impossibile sbloccare il tentativo Lightning') }
  return true
}
