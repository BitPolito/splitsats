# BOLT11 and LNURL-pay invoice verification

This patch uses the BOLT11 payment-encoding rules and LNURL-pay (LUD-06).
Invoices are untrusted payment instructions. Neither a `lnbc` prefix nor a
wallet-reported preimage length is sufficient to confirm correctness.

## Before wallet or QR

1. The **server** validates raw LNURL metadata (`text/plain` required). It
   re-requests the metadata before every invoice, hashes the **exact raw**
   `metadata` string, obtains the callback invoice, and verifies its `h` tag.
2. The shared BOLT11 parser verifies bech32 checksum, encoded amount in msats,
   mainnet prefix `lnbc`, timestamp, expiry, required payment hash (`p`),
   secret (`s`), description hash (`h`), secp256k1 invoice signature, and
   signed `n` payee key if present. No unbounded or amountless invoices.
3. The **browser** independently checks amount, mainnet, signature, expiry,
   and payment hash from the returned invoice before WebLN or QR exposure.
   The browser cannot independently re-check LNURL metadata because the proxy
   intentionally does not expose the provider callback or raw metadata.
4. A WebLN payment is reported as successful only if the returned 32-byte
   preimage hashes to the BOLT11 `p` payment hash. An invalid or missing
   preimage after `sendPayment` is **uncertain**, not safe to retry.
5. Existing durable guards and recipient-signed Nostr settlement requirements
   remain unchanged. A verified preimage is *wallet-reported evidence* and
   does not bypass recipient confirmation.

## Network, compatibility, limitations

- Production is **Bitcoin mainnet only**. Testnet and regtest invoices are
  deliberately rejected until there is an explicit environment selector.
- Exact amount in millisatoshis is required. LNURL-pay metadata must include
  the raw `metadata` string and a text/plain entry.
- This is an invoice validator, **not** an LNURL Address-to-node identity
  guarantee: callback host and node identity can legitimately differ. The
  metadata hash binds the invoice description to the metadata received from
  the provider over validated HTTPS; it does not authenticate the real-world
  identity of an LNURL operator.
- BOLT11 feature bits, routing hints, and wallet fee policy are not interpreted
  here; the wallet handles those features. Production readiness still requires
  two real wallets, public/offline relays, and a deployed Vercel smoke test.
- Invoices containing legacy `d` descriptions are accepted by the generic
  decoder, but **not** by the LNURL backend when a metadata hash is required.

## Verification

After applying, run `npm test`, `npm run build`, `npm audit`,
`npm audit --omit=dev`, `git diff --check` and a live LNURL/WebLN smoke test
with **small test funds only after review**.

References:
- https://github.com/lightning/bolts/blob/master/11-payment-encoding.md
- https://github.com/lnurl/luds/blob/luds/06.md
- https://github.com/paulmillr/noble-curves
