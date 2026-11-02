// Vercel Node.js function. Reuses exactly the same SSRF-safe LNURL logic as Vite.
import { processLnurlRequest } from '../server/lnurl-core.js'

export default async function handler(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams
  const { status, body } = await processLnurlRequest(req.method, params)
  res.statusCode = status
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Allow', 'GET, OPTIONS')
  res.end(body === null ? undefined : JSON.stringify(body))
}
