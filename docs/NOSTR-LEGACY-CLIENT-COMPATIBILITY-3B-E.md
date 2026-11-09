# SplitSats v1.0 · Phase 3B-E — legacy financial client compatibility barrier

**Prerequisite:** PR 3B-D merged into `dev`. This phase deliberately **does not
activate a financial migration**. No transaction is signed, republished,
converted or credited by this patch, and it introduces no new Nostr kind.

## Why an in-place 9000–9002 → 9600–9602 cutover is unsafe

The previous SplitSats client listens to kinds `9000`, `9001`, `9002` only.
It will not display expenses, settlement claims or recipient receipts signed
on kinds `9600`, `9601`, `9602`. A newer client that reads both namespaces
without a deterministic migration gate can double-count one logical operation
if it is republished under a different event ID.

**Critically, even unanimous kind:9603 review preferences prove only the
members' stated preferences for a specific proposal.** They cannot demonstrate
that every installed copy of SplitSats was upgraded, that all earlier signed
events were fetched, or that every relay agrees. This is true even if two
unsigned client reports claim the same empty financial history.

A safe future protocol likely needs a distinct, signed namespace commitment or
new-group transition, explicit legacy retirement semantics, verified historic
reconciliation, and independent review of all Lightning paths. This phase
implements NONE of those effects.

## Diagnostic implementation

`src/lib/financial-client-compatibility.js` exports:

- `FINANCIAL_CLIENT_KIND_MATRIX`: old reader visibility, newer parser support
  and the v2 quarantine-only guarantee for all three financial event families.
- `compareFinancialNamespaceVisibility(group, observations)`: bounded pure
  simulation over **untrusted input descriptors**, never a source of balances.
  Detects same-ID contradictions, duplicate logical operations, stale revision,
  foreign author/group, and `9600–9602` events invisible to older clients.
  An empty sample cannot prove that no earlier events existed.
- `assessFinancialClientCutoverBarrier(group, options)`: combines the existing
  read-only preflight and non-effective signed review summary. Distinguishes
  `blocked`, `pending-review`, and `review-only`. Its **invariant** is always
  `activationAllowed=false`, `v2WriterEnabled=false`, `safeForPayments=false`,
  `migrationEffective=false`, `completeHistory=false`.

Input `observedOperations` represents locally provided diagnostic identifiers,
not authenticated signatures. The app currently invokes the barrier without
that optional sample: it does not treat missing telemetry as an empty ledger.
Inputs `clientReports` remain unsigned and untrusted. An obviously foreign or
stale peer report must be rejected even when only one client report exists.

The existing `FinancialMigrationReadiness` panel now exposes the version
visibility gap, the status of the read-only barrier and its unresolved reasons.
No button for activation or a v2 writer has been added.

## Important existing defenses (unchanged)

- `assertFinancialV2PublishingDisabled` still blocks 9600–9602 before the
  Nostr signer or durable outbox is accessed.
- The 3B-B mixed-kind observer still quarantines a group on any v2 financial
  event; v2 data never enters the active legacy ledger.
- Legacy signatures remain immutable and legacy financial events remain
  readable; member consent, confirmation receipts and payment-attempt locks
  stay enforced in their original paths.
- EOSE is not a guarantee of relay completeness, payment finality or even
  permanent agreement among relays.

## Privacy and deployment

Do not publish sample events to public Nostr relays or send actual financial
personal data while the protocol has no payload encryption. Use fake group
identities in tests. Kind:9603 reviews are public, not private receipts.

## Validation

```bash
npm ci
npm test
npm run test:e2e
npm run build
npm audit
npm audit --omit=dev
git diff --check
```

No real Lightning payments in migration testing. The new unit tests do not
constitute verification of a production cutover.
