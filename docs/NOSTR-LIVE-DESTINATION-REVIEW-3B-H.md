# SplitSats v1.0 · Phase 3B-H — live, non-executing destination review

**Prerequisite:** merged Phase 3B-G, on clean `dev`.

A member of a verified, genesis-only, signed-invite group can explicitly sign
`kind:9604` (`support-target-review` or `decline-target-review`) after seeing the
exact author-scoped target `30001:<owner>:<derived-target-id>` and its SHA-256
proposal fingerprint. A confirmation checkbox explains that this is a PUBLIC,
**non-executable** preference, not group creation or a payment.

## Architecture

- `financial-destination-live.js`: pure, fail-closed signature-admission guard.
  Requires signed current-head consensus on kind:9603, a locally derived
  target proposal, empty and readable account-scoped outbox, matching-current
  relay audit and no conflict or financial locks. A pending signed 9604
  blocks a second signature for the same account and proposal.
- `subscribeFinancialDestinationConsents`: signature-verified RelayPool reads
  immutable `kind:9604` with exact source `a/g/r`, proposal `x`, target `z`
  and member authors. The subscription is **live**, so post-EOSE events are
  normal; the separate audit compares signed envelopes from relays and marks
  conflict, overflow and saturation. A matching relay snapshot is only a
  diagnostic and cannot prove global completeness.
- The Zustand store tracks source-head/proposal-scoped read-only rows, sticky
  conflicts and the per-relay diagnostic state. It rejects stale callbacks,
  duplicate signer preferences, changed targets and account switches. It
  never writes these observations into `expenses`, `settlements` or `confirmations`.
- `publishEvent()` handles NIP-07 verification, persistence before network I/O,
  NIP-20 ACK and durable replay of the **same signed event ID**. A timeout is
  uncertain delivery: use the existing outbox retry, never sign again.
- The UI shows exact target, proposal hash, pending signatures and an explicit
  public-consent confirmation. No target group creation button is provided.

## Security boundaries

1. The signed preferences `9603` are NOT `9604` consent; neither is a signed
   authorization to create a group, migrate debts or retire old devices.
2. No new group is published. Financial writers `9600-9602` stay **disabled**
   in `publishEvent`. Existing financial records and Lightning safeguards are
   unchanged.
3. A validated, unanimous `9604` review is still **review-only**. Never use
   `matching-observed` or EOSE as proof of completeness, privacy or finality.
4. An event already persisted to outbox may remain on a relay even after a
   local disconnect; don't clear it or produce another signature manually.
5. These public Nostr events disclose group addresses, member pubkeys and the
   proposed destination. Test with fake identities and no real satoshis.

## Verification

```sh
npm ci
npm test
npm run test:e2e
npm run build
npm audit
npm audit --omit=dev
git diff --check
```

Before releasing any live financial namespace, require a separate protocol
review, cross-device/relay integration tests and explicit safe handling of
legacy clients. This phase is not a release authorization.
