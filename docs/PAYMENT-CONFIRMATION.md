# Phase 4 — Recipient-confirmed settlements (Nostr kind 9002)

This is a **recipient-attestation workflow**, not Lightning network settlement verification. WebLN resolving successfully is a *wallet-reported result*, and a user may self-report a manual or QR payment. In both cases the balance changes **only after the payee signs a confirmation**. The recipient should check their own Lightning wallet before approving.

## Protocol

- `kind:9001`, signed by the payer: `id`, `from`, `to`, `amount` (integer sats), `method: 'manual' | 'webln'`, `walletReported` and `settledAt` with `g`, `p` (payee), `t: splitsats` tags. It is a **claim**, never itself an approved balance adjustment.
- `kind:9002`, signed by the payee: `id`, `settlementEventId` (the exact Nostr ID of the `kind:9001` event), `from`, `to`, `amount`, `confirmedAt` and signed `g`, `e` (claim ID), `p` (payer), `t: splitsats` tags. The browser verifies Nostr signatures before application-level parsing.
- Consumers confirm that the payee signed the event and match all four values: claim event ID, from, to and amount. A confirmation cannot authorize another claim. Repeated confirmations cannot multiply credited amounts.
- Groups subscribe to confirmations just like expenses and settlement claims. Confirmation can arrive before its referenced claim. The receiver can approve only a claim addressed to their pubkey.
- `approvedSettlements(settlements, confirmations)` is used for all visible group debts. Old `kind:9001` entries with no confirmation are treated as **pending** and require approval by the receiver (migration impacts historical balances).
- New unresolved claims temporarily block an additional payment request between the same payer and payee to reduce accidental double payments. There is no claim expiry or cancellation yet, so a dishonest/absent receiver may leave a claim unresolved; add cancel/dispute workflow later.

## Workflow

1. Debtor selects PAY. Via WebLN the app waits for `sendPayment` and publishes a settlement claim; via QR/manual it publishes only when the user declares they paid. The development WebLN mock cannot settle debts.
2. Both users see the pending claim, with wallet-reported vs manually declared clearly distinguished.
3. Recipient verifies receipt in their own Lightning wallet, then selects **CONFIRMA RICEZIONE**, signs `kind:9002` through NIP-07.
4. After this event is received, all clients recalculate balances using only recipient-confirmed claims.

## Test manually with two Nostr accounts

- Create a group with 2 accounts; create an expense and note balances.
- Simulate a manual payment from debtor; verify that the claim is visible and balances do **not** change.
- On recipient account, check wallet and click confirm; sign; verify balances update on both clients.
- Repeat after reloading both clients; the confirmed record must still be applied once.
- Verify the recipient cannot approve another member's incoming claim; a user cannot confirm their own outgoing claim.
- With WebLN enabled, confirm the wallet's reported result **never** auto-settles the group debt. With QR, check that showing an invoice alone creates no settlement.

## Explicit limitations / next work

- A payee confirmation is an application-level receipt, **not** independent cryptographic evidence from the Lightning Network. Real settlement verification would require a receiver wallet/node status API or validated BOLT11 payment preimage plus invoice authenticity and recipient binding.
- A recipient can knowingly approve a transfer they never received; this is an intentional trust/approval decision. There is no dispute/cancel/revoke protocol yet.
- Relay publication is optimistic and still lacks relay ACK handling; if event delivery fails, a user might need to retry publishing. Avoid sending a second Lightning payment without checking wallet history.
- `lud06` alone is not a Lightning Address and is not used as a pay destination by this patch.
- Older records that previously counted toward the balance now appear pending until payee confirmation; communicate that migration to existing users before deployment. No historical records are deleted.
- Test suite covers validation/reconciliation, not live wallet/relay integration. End-to-end and cross-device testing are required before real-money use.
