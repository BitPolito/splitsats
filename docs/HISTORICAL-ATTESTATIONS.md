# SplitSats — Phase 2E-C-A: signed audit snapshot attestations

## Scope

Phase 2E-B provides a best-effort reconstruction of previously observed financial
Nostr events for older, signed membership revisions. The amounts shown are NOT
final balances, and no payment may be released on their basis. 2E-C-A adds
*participant attestations* to a deterministic snapshot of that **observed**
replay. A signature attests that a particular account observed this exact set of
Nostr event IDs and simulated balances; it does NOT prove that all events were
delivered, that a Lightning payment occurred, or that debts are discharged.

## Protocol

- Custom **immutable kind 9596** (`historical attestation`), signed via NIP-07.
- All participants across the current and prior revisions, including removed
  members, must individually sign the **same** snapshot hash. The producer of
  the group definition cannot sign on behalf of anybody else.
- Canonical snapshot SHA-256 covers version, author-scoped group address,
  current revision-event head, the sorted union of participant public keys,
  sorted immutable signed financial/invitation event IDs with kinds, authors
  and timestamps, and integer satoshi net amounts for the full participant
  union. Hashing event IDs relies on the RelayPool's cryptographic Nostr
  event verification. Inputs are bounded and must pass the existing 2E-B
  read-only replay with `status='observed'`.
- The signed event has unique tags `g`, `a`, `r` (current head), `x` (hash),
  `t=splitsats` and a `p` tag for every historical/current participant.
  Signed JSON fields are exactly `{version:1, action:'attest-historical-v1',
  groupId, revisionEventId, snapshotHash}`.
- A new revision invalidates all old-head attestations. A signer may sign only
  once; duplicate immutable IDs are idempotent, while divergent or competing
  signatures become conflict. Signers can attest only their own key.
- No snapshot is available until the initial older-head EOSE, signed 2E-B
  replay is `observed`, relevant financial events were actually detected and
  no overflow or malformed/unsupported activity is known.

## Explicit security boundaries

- **Even unanimous status `attested` leaves `safeForPayments=false`.** It does
  not clear `_financialReviewRequired`, mutate `expenses` or `settlements`, or
  permit Lightning operations or further membership changes with debt.
- EOSE is a relay sync signal, not cryptographic completeness or finality.
  Selectively omitting or stale relays can deceive every participant.
- The snapshot commits to *observed* balances only; the app is not a proof of
  actual Lightning receipts. Future production work requires independent
  observers, cross-revision reconciliation semantics and explicit releases.
- Removed participants do not necessarily discover the group through its
  current NIP-33 `p` tags. The UI in this phase only allows **current** members
  to sign. Former members' externally signed valid attestations can be
  observed, but a dedicated safe historical-member discovery flow remains
  unimplemented. The protocol will remain pending otherwise.
- The publication uses the existing signed durable outbox. On uncertain ACK,
  retry the identical signed event, never re-sign a second operation.

## Testing

Added 12 pure Node tests. Run the full repository suite and browser regressions:

```bash
npm ci && npm test && npm run test:e2e && npm run build && npm audit && npm audit --omit=dev && git diff --check
```

Keep this change separate from any real payment flow. Do not use actual funds
for acceptance tests.
