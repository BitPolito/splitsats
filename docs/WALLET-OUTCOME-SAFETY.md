# WebLN payment outcome safety

## Problem

Calling `webln.sendPayment(invoice)` can cause an irreversible Lightning payment even
when the returned promise rejects (network timeout, browser crash, extension fault).
Treating every exception as a failed payment and enabling Pay again can therefore
cause a second payment.

## Behaviour

- Errors before submission to the wallet (LNURL request, invalid amount or unavailable
  wallet) remain safe to retry.
- Immediately before invoking `sendPayment`, the wallet helper invokes
  `onWalletSubmission`. The payment form then disables *Pay with Alby* and the QR
  fallback for the remainder of the open form.
- Any failure after invoking `sendPayment` is tagged
  `WALLET_PAYMENT_OUTCOME_UNKNOWN`, including a missing or invalid preimage.
  Such failures are **not** proof that no funds moved.
- Users with an uncertain outcome must check the wallet transaction history.
  They can record a *manual payment claim* only after explicitly acknowledging
  that they saw an executed payment. This is not tagged as WebLN-verified; it is
  still pending a recipient-signed Nostr confirmation.
- A valid 32-byte hex preimage returned by WebLN is treated only as a
  **wallet-reported** success; it is **not** cryptographically checked against
  the BOLT11 invoice or the recipient wallet.

## Limits

The form lock is in memory and is **not durable across tab closes, reloads, or
other devices**. Always check the wallet history before paying again after a crash.
This patch does not provide network-level Lightning settlement verification.
Future work: persist an invoice-scoped payment-attempt record with a deliberate
recovery flow, verify invoice payment hash/amount/expiry, and test against two real
wallets. Never blindly retry Lightning payments on a relay publication error.

## Verification

`node --test tests/wallet-payment-outcome.test.js` tests wallet success, network
errors, synchronous failures, malformed wallet results and safe failures before
wallet submission. `npm test && npm run build` should also pass.
