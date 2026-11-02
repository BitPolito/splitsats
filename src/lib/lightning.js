// ─── Lightning / WebLN helpers ────────────────────────────────────────────────
// LNURL calls go through /api/lnurl (Vercel Edge Function in prod,
// Vite plugin middleware in dev) to bypass browser CORS restrictions.

export const hasWebLN = () => typeof window !== 'undefined' && typeof window.webln !== 'undefined'

export async function enableWebLN() {
  if (!hasWebLN()) throw new Error('WebLN non disponibile. Installa Alby.')
  await window.webln.enable()
}

// ── Step 1: resolve Lightning Address → LNURL-pay metadata ──
export async function resolveLightningAddress(address) {
  const [user, domain] = (address || '').split('@')
  if (!user || !domain) throw new Error('Lightning Address non valido')

  const res = await fetch(`/api/lnurl?address=${encodeURIComponent(address)}`)
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error || `Errore HTTP ${res.status}`)
  return data
}

// ── Step 2: fetch BOLT11 invoice ──
export async function fetchInvoice(callbackUrl, amountSats) {
  const encoded = encodeURIComponent(callbackUrl)
  const res     = await fetch(`/api/lnurl?callback=${encoded}&amount=${amountSats * 1000}`)
  const data    = await res.json()
  if (!res.ok || data.error) throw new Error(data.error || `Errore HTTP ${res.status}`)
  if (!data.pr) throw new Error('Nessuna invoice ricevuta dal server')
  return data.pr
}

// ── Full pay flow (with WebLN) ──
export async function payLightningAddress(address, amountSats) {
  await enableWebLN()
  const meta    = await resolveLightningAddress(address)
  const minSats = Math.ceil((meta.minSendable || 1000) / 1000)
  const maxSats = Math.floor((meta.maxSendable || 1e10) / 1000)
  if (amountSats < minSats) throw new Error(`Minimo: ${minSats.toLocaleString()} sats`)
  if (amountSats > maxSats) throw new Error(`Massimo: ${maxSats.toLocaleString()} sats`)
  const invoice = await fetchInvoice(meta.callback, amountSats)
  const result  = await window.webln.sendPayment(invoice)
  return { preimage: result.preimage, invoice }
}

// ── QR fallback: generate invoice without WebLN ──
export async function generateInvoiceForAddress(address, amountSats) {
  const meta = await resolveLightningAddress(address)
  return fetchInvoice(meta.callback, amountSats)
}

// ── Dev mock — injected only in development when Alby is absent ──
export function injectDevMock() {
  if (typeof window === 'undefined') return
  if (window.webln) return // real WebLN already present, don't override
  console.info('[SplitSats] WebLN mock attivo (dev) — nessun pagamento reale')
  window.webln = {
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
