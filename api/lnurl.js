// api/lnurl.js — Vercel Edge Function
// Proxies LNURL-pay requests to bypass browser CORS restrictions.
// The app calls /api/lnurl?address=user@domain.com instead of hitting
// the Lightning server directly.

export const config = { runtime: 'edge' }

export default async function handler(req) {
  const { searchParams } = new URL(req.url)
  const address  = searchParams.get('address')  // user@domain.com
  const callback = searchParams.get('callback') // LNURL callback URL
  const amount   = searchParams.get('amount')   // msats (for invoice step)

  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors })
  }

  try {
    // ── Step 1: resolve Lightning Address → LNURL-pay metadata ──
    if (address) {
      const [user, domain] = address.split('@')
      if (!user || !domain) {
        return json({ error: 'Lightning Address non valido' }, 400, cors)
      }

      // Try https first, fall back to http for onion/local
      const url = `https://${domain}/.well-known/lnurlp/${user}`
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        cf: { cacheTtl: 60 }, // cache 60s on Vercel edge
      })

      if (!res.ok) {
        return json({ error: `Impossibile raggiungere ${domain} (${res.status})` }, 502, cors)
      }

      const data = await res.json()
      return json(data, 200, cors)
    }

    // ── Step 2: fetch invoice from LNURL callback ──
    if (callback && amount) {
      const callbackUrl = new URL(decodeURIComponent(callback))
      callbackUrl.searchParams.set('amount', amount)

      const res = await fetch(callbackUrl.toString(), {
        headers: { 'Accept': 'application/json' },
      })

      if (!res.ok) {
        return json({ error: `Errore callback LNURL (${res.status})` }, 502, cors)
      }

      const data = await res.json()
      if (data.status === 'ERROR') {
        return json({ error: data.reason || 'Errore sconosciuto' }, 400, cors)
      }

      return json(data, 200, cors)
    }

    return json({ error: 'Parametri mancanti: serve address oppure callback+amount' }, 400, cors)

  } catch (err) {
    return json({ error: err.message || 'Errore interno' }, 500, cors)
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  })
}
