# SplitSats v1.0 · Phase 3B-F — independent financial namespace planning

**Prerequisite:** Phase 3B-E must be merged into `dev`. This step is strictly
**local-only, diagnostic and non-executable**. No signed event is published, no
outbox entry is created, no new Nostr group is created, no balance is imported,
and no Lightning payment or financial writer is enabled.

## Problem

A same-group switch from `9000–9002` to `9600–9602` is not safe: older clients
will continue to write and display the legacy kinds, and they cannot see v2
operations. A developer cannot infer that every device has upgraded from
matching local reports or even from unanimous signed kind `9603` **review
preferences**. The `9603` proposal describes a review of an in-place change;
its signatures are **NOT** consent to a separate new group.

## Plan, not migration

`src/lib/financial-namespace-plan.js` provides:

- `FINANCIAL_NAMESPACE_STRATEGIES`: in-place switch **forbidden**, independent
  new-group migration **future-proposal-only**.
- `buildFinancialNamespacePlan(group, options)`: checks prior conservative
  group preflight, mixed-kind client barrier, historical locks, empty verified
  genesis-only financial ledger and outbox, reviewed roster, and unanimous
  *observed* signed `9603` preferences. Missing or contradictory evidence
  produces no fingerprint. Passing checks merely yields `proposal-only`.
- Its SHA-256 diagnostic fingerprint commits to the source Nostr address,
  source revision, sorted members, proposal identifier and signed review event
  IDs. It is stable across arrival order and never contains amounts, preimages,
  invoices or LNURL destinations. Changing source, head, members or signed
  evidence alters or invalidates the fingerprint.
- `compareFinancialNamespacePlans(group, reports)`: compares two or more
  **unauthenticated** local preview fingerprints. Matching results have status
  `matching-claimed`, not `verified`, `authorized`, or `ready`.

**No generated preview is a valid target Nostr group ID, target namespace,
financial commitment, ledger opening balance or authorization.** The return
value always contains:

```
activationAllowed=false, v2WriterEnabled=false, migrationEffective=false,
safeForPayments=false, completeHistory=false, signedNewGroupCreated=false,
balancesTransferred=false, legacyNamespaceRetired=false,
proposedNewGroupId=null, proposedNewGroupAddress=null
```

The UI section in `FinancialMigrationReadiness` makes this limitation explicit.
It has no button to create a group, approve a cutover, or import prior balances.

## Requirements before any production implementation

A later, independently audited phase must define:

1. A **new group** with a separate, immutable author-scoped coordinate and an
   explicit protocol version, not a silent in-place kind replacement.
2. Fresh NIP-07 member signatures explicitly referring to that **new target**
   and its exact rules. The earlier `9603` reviews cannot be repurposed.
3. A migration policy for already existing expenses and unsettled claims.
   Never rewrite signed legacy events or copy unverified balances.
4. A credible old-client retirement process and a *fail-closed* strategy for
   devices that continue to publish on legacy kind `9000–9002`.
5. Replay-safe cross-device tests across relays and network disconnects, and
   separate review of all payment-attempt locks and Lightning confirmations.

Nostr EOSE is a snapshot indicator, not global completeness, network finality
or absence of historical events. Even a SHA-256 match cannot prove those things.

## Security and privacy

Kind `9603` preferences and legacy finance are public on relays. Test with
synthetic accounts and fake amounts only; do not use real payments. The local
fingerprint includes identifiers already present in public signed material,
but its presence does not confer consent or authority.

## Validation

```sh
npm ci
npm test
npm run test:e2e
npm run build
npm audit
npm audit --omit=dev
git diff --check
git status -sb
```

The new module is covered by 29 additional unit tests. No full repository,
CI or browser tests are claimed to have run in the development container.
