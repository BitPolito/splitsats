import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { processLnurlRequest } from './server/lnurl-core.js'

// The local dev endpoint intentionally shares the same validation and HTTPS
// transport as Vercel, instead of using an unsafe ad-hoc HTTP proxy.
function lnurlProxyPlugin() {
  return {
    name: 'lnurl-proxy',
    configureServer(server) {
      server.middlewares.use('/api/lnurl', async (req, res) => {
        try {
          const params = new URL(req.url, 'http://localhost').searchParams
          const { status, body } = await processLnurlRequest(req.method, params)
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.setHeader('Cache-Control', 'no-store')
          res.setHeader('X-Content-Type-Options', 'nosniff')
          res.setHeader('Allow', 'GET, OPTIONS')
          res.end(body === null ? undefined : JSON.stringify(body))
        } catch {
          res.statusCode = 502
          res.end(JSON.stringify({ error: 'Errore del proxy LNURL' }))
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), lnurlProxyPlugin()],
  define: { global: 'globalThis' },
  resolve: { alias: { '@': '/src' } },
})
