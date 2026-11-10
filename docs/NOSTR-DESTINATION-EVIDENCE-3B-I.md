# SplitSats v1.0 — 3B-I · Signed destination evidence comparison

Prerequisite: merge Phase **3B-H / PR #43** into `dev`. This phase does not
create a new group, publish new financial event kinds, transfer balances,
retire old clients or execute any Lightning operation.

## Objective

Two browser instances can independently recover **PUBLIC signed kind:9604
Nostr envelopes** from relays, export only the immutable public event fields,
and compare their observations by verifying the signatures **again** locally.
A matching comparison is not a global Nostr history proof and cannot turn any
review preference into a financial authorization.

### Workflow

1. Each member signs their exact-target `9604` *non-executing review* using
   the existing Phase 3B-H flow. This persists the original signed event
   in the account-scoped outbox before the first publication attempt.
2. The already-existing group-scoped subscription receives the verified raw
   event from RelayPool. Its signature is **checked again** by
   `nostr-tools.verifyEvent` before the seven public NIP-01 envelope fields
   are retained in `_destinationSignedEvidence`. Neither the private key nor
   any invoice, payment status, wallet object or balance is exported.
3. The **3B-I** panel (under the destination preview) shows an exportable JSON
   proof set scoped to the exact source group/revision and proposed target.
   Copy it from browser A to browser B and press **VERIFICA FIRME E CONFRONTA**.
   Browser B checks the Schnorr signatures, group/revision, target, and IDs
   from scratch. Repeat in the opposite direction if desired.
4. A signed event arriving after EOSE or after a relay reconnect is normal
   and is deduplicated by the immutable Nostr ID. A network refresh must not
   create a new signature. An uncertain publication is recoverable only by
   retrying the **original** event via the durable outbox.

## Statuses and limits

- `matching-verified-events-only`: both manually provided observations
  contain exactly the same valid signed envelopes. The claimed relay status
  is **unsigned**, and the browser identity is not cryptographically proven.
- `divergent`: two valid evidence sets contain different signed events.
- `pending` / `pending-relay-observation`: no proven events or incomplete
  reported relay observations. No inference about absent history is allowed.
- `blocked` / `conflict` / `invalid`: malformed data, wrong signature,
  stale revision, alternate target, contradictory member signatures,
  invalid format or limits. All fail closed.
- Up to 200 public events and at most 160 KB per compact proof bundle.
  The 9604 group subscription still enforces its own query limit and does NOT
  prove all historical events were retrieved.

The local signed event cache is invalidated on a new signed group revision;
external exports are validated against the currently recomputed local draft
and cannot be borrowed from an older revision. Cached data is not trusted at
app startup; the existing signed group/subscription reconstruction remains
responsible for replay.

## Never infer financial readiness

All module results retain:

- `activationAllowed=false`
- `migrationEffective=false`
- `v2WriterEnabled=false`
- `safeForPayments=false`
- `completeHistory=false`
- `signedNewGroupCreated=false`
- `balancesTransferred=false`
- `legacyNamespaceRetired=false`

A copied report is not independent proof that every peer has updated, that
all Nostr relays agree, or that Lightning was paid. No extra payment or Nostr
publication API is added by this phase.

## Privacy

9604 Nostr events are already **public** and identify member pubkeys,
source group, destination and signed preferences. The JSON export contains
only those public fields; nevertheless, avoid forwarding it unnecessarily.
Use test identities and zero real Bitcoin in staging.

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

The pure test suite uses a simulated verifier seam to test validation logic.
The additional `financial-destination-crypto.test.js` signs and verifies real
Nostr Schnorr events via `nostr-tools`, without publishing to a relay. Manual
browser tests with two genuine NIP-07 identities are still required before a
public rollout.
