import { beginPaymentAttempt, getPaymentAttempt, withPaymentOperationLock } from './payment-attempts.js'

// ─── Lightning / WebLN helpers ────────────────────────────────────────────────
// LNURL calls go through /api/lnurl (Vercel Node.js Function in prod,
// Vite plugin middleware in dev) to bypass browser CORS restrictions.

export const hasWebLN = () => typeof window !== 'undefined' && typeof window.webln !== 'undefined'

export async function enableWebLN() {
  if (!hasWebLN()) throw new Error('WebLN non disponibile. Installa Alby.')
  await window.webln.enable()
}

// ── Step 1: resolve Lightning Address → LNURL-pay metadata ──
export async function resolveLightningAddress(address) {
  if (typeof address !== 'string' || !address.includes('@')) throw new Error('Lightning Address non valido')

  const res = await fetch(`/api/lnurl?address=${encodeURIComponent(address)}`)
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error || `Errore HTTP ${res.status}`)
  return data
}

// ── Step 2: fetch BOLT11 invoice ──
export async function fetchInvoice(address, amountSats) {
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0 ||
      amountSats > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
    throw new Error('Importo in satoshi non valido')
  }
  const res = await fetch(`/api/lnurl?address=${encodeURIComponent(address)}&amount=${amountSats * 1000}`)
  const data    = await res.json()
  if (!res.ok || data.error) throw new Error(data.error || `Errore HTTP ${res.status}`)
  if (!data.pr) throw new Error('Nessuna invoice ricevuta dal server')
  return data.pr
}

// ── Full pay flow (with WebLN) ──
// Once sendPayment has been invoked, a rejected promise does NOT prove the wallet
// failed to pay. Never automatically retry the invoice after this error.
function uncertainWalletOutcome(cause) {
  const error = new Error('Esito del wallet incerto: controlla la cronologia Lightning prima di altre operazioni.')
  error.code = 'WALLET_PAYMENT_OUTCOME_UNKNOWN'
  error.cause = cause
  return error
}

export async function payLightningAddress(address, amountSats, { onWalletSubmission } = {}) {
  await enableWebLN()
  if (window.webln.__splitsatsMock) throw new Error('Wallet simulato: nessun pagamento reale. Non usare il mock per saldare debiti.')
  const meta    = await resolveLightningAddress(address)
  const minSats = Math.ceil((meta.minSendable || 1000) / 1000)
  const maxSats = Math.floor((meta.maxSendable || 1e10) / 1000)
  if (amountSats < minSats) throw new Error(`Minimo: ${minSats.toLocaleString()} sats`)
  if (amountSats > maxSats) throw new Error(`Massimo: ${maxSats.toLocaleString()} sats`)
  const invoice = await fetchInvoice(address, amountSats)
  // The callback fires immediately before handing the invoice to WebLN, so the
  // UI can lock the payment button before the wallet has a chance to settle.
  // The durable guard must be written BEFORE the invoice reaches WebLN.
  // An asynchronous storage callback may reject; in that case do not send.
  await onWalletSubmission?.({ invoice })
  try {
    const result = await window.webln.sendPayment(invoice)
    // A successful WebLN response is still wallet-reported, not an independent
    // Lightning settlement proof. Missing/malformed preimages remain uncertain.
    if (typeof result?.preimage !== 'string' || !/^[0-9a-f]{64}$/i.test(result.preimage)) {
      throw new Error('WebLN non ha fornito una preimage valida')
    }
    return { preimage: result.preimage, invoice }
  } catch (error) {
    throw uncertainWalletOutcome(error)
  }
}

// ── QR fallback: generate invoice without WebLN ──
export async function generateInvoiceForAddress(address, amountSats) {
  return fetchInvoice(address, amountSats)
}

// An invoice shown to a user can be paid with a wallet we cannot observe.
// Reserve a durable, account-scoped attempt BEFORE exposing it to the UI.
// A second QR (or WebLN payment) for the same debtor/group/payee is blocked.
export async function prepareExternalWalletInvoice(address, amountSats, scope, { ensureSigner } = {}) {
  if (typeof ensureSigner !== 'function') throw new Error('Verifica dell’account Nostr obbligatoria')
  return withPaymentOperationLock(scope, async () => {
    if (getPaymentAttempt(scope)) {
      const error = new Error('Esiste già un tentativo di pagamento: controlla il wallet e il destinatario')
      error.code = 'PAYMENT_ATTEMPT_PENDING'
      throw error
    }
    const invoice = await fetchInvoice(address, amountSats)
    // The signer could have switched while the network request was pending.
    // Fail BEFORE recording or exposing the invoice if identity has changed.
    await ensureSigner()
    const attempt = beginPaymentAttempt(scope, amountSats)
    return { invoice, attempt }
  })
}

// ── Dev mock — injected only in development when Alby is absent ──
export function injectDevMock() {
  if (typeof window === 'undefined') return
  if (window.webln) return // real WebLN already present, don't override
  console.info('[SplitSats] WebLN mock attivo (dev) — nessun pagamento reale')
  window.webln = {
    __splitsatsMock: true,
    enable:      async () => {},
    sendPayment: async (invoice) => {
      console.log('[mock] sendPayment:', invoice)
      await new Promise(r => setTimeout(r, 1200))
      return { preimage: 'mock_' + Math.random().toString(16).slice(2) }
    },
    makeInvoice: async ({ amount }) => ({
      paymentRequest: 'lnbc' + amount + 'mock' + Date.now(),
    }),
  }
}
