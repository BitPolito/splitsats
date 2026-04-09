import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createServer as createHttpsServer } from 'https'
import { request as httpsRequest } from 'https'
import { request as httpRequest } from 'http'

// Dev proxy middleware — replicates what api/lnurl.js does on Vercel
function lnurlProxyPlugin() {
  return {
    name: 'lnurl-proxy',
    configureServer(server) {
      server.middlewares.use('/api/lnurl', (req, res) => {
        const url  = new URL(req.url, 'http://localhost')
        const addr = url.searchParams.get('address')
        const cb   = url.searchParams.get('callback')
        const amt  = url.searchParams.get('amount')

        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json')

        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }

        const proxyFetch = (targetUrl) => {
          const mod = targetUrl.startsWith('https') ? httpsRequest : httpRequest
          const r = mod(targetUrl, { headers: { Accept: 'application/json' } }, (upstream) => {
            let data = ''
            upstream.on('data', c => data += c)
            upstream.on('end', () => { res.statusCode = upstream.statusCode; res.end(data) })
          })
          r.on('error', (e) => { res.statusCode = 502; res.end(JSON.stringify({ error: e.message })) })
          r.end()
        }

        if (addr) {
          const [user, domain] = addr.split('@')
          if (!user || !domain) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Indirizzo non valido' })); return }
          proxyFetch(`https://${domain}/.well-known/lnurlp/${user}`)
          return
        }

        if (cb && amt) {
          const cbUrl = new URL(decodeURIComponent(cb))
          cbUrl.searchParams.set('amount', amt)
          proxyFetch(cbUrl.toString())
          return
        }

        res.statusCode = 400
        res.end(JSON.stringify({ error: 'Parametri mancanti' }))
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), lnurlProxyPlugin()],
  define: { global: 'globalThis' },
  resolve: { alias: { '@': '/src' } },
})
