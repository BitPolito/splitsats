# LNURL proxy hardening (second patch)

## Threat model and API contract

The old Vercel Edge and Vite handlers fetched an arbitrary `callback` supplied in
`/api/lnurl?callback=...&amount=...`. That was an SSRF vector. The new endpoint
accepts only these GET requests:

- `/api/lnurl?address=user%40domain.tld` to read sanitized payRequest limits;
- `/api/lnurl?address=user%40domain.tld&amount=1000` to fetch a BOLT11 invoice
  for 1,000 millisatoshis.

The server resolves LNURL-pay metadata from the Lightning Address first, checks
`tag`, `minSendable`, `maxSendable` and callback URL, then contacts the callback
with the requested amount. Passing `callback` directly is now rejected.

## Protections

- Node.js backend on Vercel and Vite dev share one implementation.
- HTTPS only on standard port, no URL credentials, fragments or literal IP hosts.
- No HTTP redirects; upstream response size limited to 64 KiB; 7-second deadline.
- Each HTTPS connection uses a custom DNS lookup that rejects non-public IPv4
  addresses **at connect time**, pinning the validated IP for the socket; this
  closes the usual DNS-check/DNS-rebinding gap.
- Both step 1 and step 2 requests receive the same protections.
- Strict input and amount validation; `Cache-Control: no-store`; no wildcard CORS.
- Reject unknown/duplicate query parameters and generic upstream errors.

## Compatibility/operational notes

- Deliberately IPv4-only for upstream hosts, since IPv6 routing and transition
  address classification is not yet implemented. IPv6-only LNURL providers will
  fail closed. Non-HTTPS and `.onion` providers are intentionally not supported.
- Some providers return very large LNURL metadata, unusual callback ports, or
  require additional LNURL extensions; they may not be compatible.
- For QR fallback the generated invoice is **not** proof of payment. The app does
  not verify settlement independently. Do **not** auto-mark QR payments as paid.
- The shared `src/lib/bolt11.js` validator decodes BOLT11, checks the requested
  network and amount, verifies the invoice signature, payment hash and payment
  secret, validates timestamp/expiry, and compares the description hash with
  LNURL metadata when supplied. Regression tests cover signed invoices, tampering,
  amount/network/expiry mismatches and preimage-to-payment-hash verification.
- Invoice validation does **not** prove that an invoice was paid. A QR invoice
  remains pending until the recipient confirms receipt; never treat invoice
  generation or a payer-side wallet response alone as settlement evidence.
- There is no durable per-IP rate limit. For an internet-exposed deployment,
  configure platform-level quotas or rate limiting to prevent relay abuse.
- `lud06` LNURL strings still are not Lightning Addresses; separately support
  bech32 decoding or present a clear warning in the UI.

## How to verify

1. Apply this patch on top of `fix/session-balance-consistency` or its merge in
   `dev` (not directly on the original `master`).
2. Run `npm ci && npm test && npm run build`.
3. In the browser, test lookup, invoice generation and WebLN payment on a known
   HTTPS Lightning Address. Manual QR confirmations remain manual.
4. Before any production deploy, manually probe invalid/private callback URLs,
   provider redirects, unavailable DNS and overlong responses in a controlled
   environment.

This patch addresses the generic proxy SSRF path, **not all payment-system risks**.
