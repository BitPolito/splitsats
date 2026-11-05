# SplitSats — Phase 2E-F-A: read-only historical debt disposition preview

## Position in the v1.0 roadmap

The v1.0 roadmap separates (01) protocol definition, (02) historic
reconciliation, (03) Nostr migration, (04) Lightning, (05) privacy,
(06) UX, (07) hardening and (08) release. This is a **subphase of 02**, not
an implementation of debt discharge or production payment authorization.

## What a preview represents

After a `9597` reconciliation checkpoint has been independently acknowledged
by every participant (including all verified former members), the app can
show two hypothetical dispositions:

1. `retain-historical-record`: keep the entire historical *net vector* in
   its old, segregated audit context. No carry-over into the current group's
   active ledger, no payment and no newly created obligation.
2. `propose-mutual-waiver`: simulate reducing the net vector to zero for
   everyone. This is only a **draft of a potential mutual agreement**.
   Displaying or selecting it does not mean consent, legal forgiveness,
   discharge, or payment. Each affected person must explicitly agree in a
   separate, future signed protocol with a clear scope.

Both drafts have `effective:false`, `safeForPayments:false` and
`completeHistory:false` and cannot be published to a relay in this phase.
No new Nostr event kind has been introduced yet; the v1 protocol must be
specified and reviewed before introducing binding events.

## Checks (fail closed)

- Verified signed owner revision chain with union of *all* historical members.
- Historical review lock is still active; no overflow and no contradiction.
- The original snapshot and the reconciliation decision relays both report
  matching observed signed event IDs, every configured source EOSE-completed.
  Relay agreement is **not** proof that all historical evidence exists.
- Reconciliation (`9597`) must be unanimously `agreed`, with no competing
  checkpoint, multiple signer, invalid signature-derived evidence or explicit
  store/archive conflict flag.
- The old source snapshot hash, current revision and participant roster must
  match the agreed checkpoint. Net values must be sorted, bounded, exact
  integer satoshis that sum to zero.
- The *entire* old checkpoint SHA-256 is recomputed from the original
  2E-E-A canonical object and its actual proposed net vector. A locally
  modified vector cannot borrow an agreed checkpoint's signed hash.
- Each displayed draft has a deterministic domain-separated SHA-256
  (`draft-historical-disposition-v1`) that includes the group identity,
  source hashes, revision and before/after vectors. **Not a binding signature.**

## Limitations

An all-relays-matching observation may still omit censored history. A net
vector does not establish all bilateral legal creditors/debtors. A waiver
needs legally meaningful consent rules, scope, authorization, revocation,
finality, ex-member handling and conflict resolution. The next design step
(2E-F-B) must review these issues before creating signed financial release
messages. Do not pay actual sats to test this phase.

## Test and review

```
npm ci
npm test
npm run test:e2e
npm run build
npm audit
npm audit --omit=dev
git diff --check
```

The initial tests cover both previews, former members, changed revision,
relay mismatch, double signing, missing unanimity, malformed/unbalanced values,
local checkpoint tampering, safety flags and deterministic draft hashes.
