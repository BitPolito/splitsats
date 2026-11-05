# Phase 2E-E-B — reconciliation conflict diagnostics and per-relay decision safety

## Why

2E-E-A introduced a second, explicitly signed `kind:9597` acknowledgment of an
observed historical net vector. The first implementation waited for `EOSE`
from all decision relays but **did not compare their event snapshots**. Two
relays could therefore disagree about signed acknowledgments, yet the client
could offer its own additional signature. This phase tightens that gate.

## New boundaries

- The `kind:9597` subscription now uses the signature-verified per-source
  `RelaySnapshotAudit`, before application-level event-ID deduplication.
- It is eligible for a new acknowledgment only when at least two configured
  relay snapshots are `matching-observed`, every configured relay has EOSE,
  and there is no overflow, 500-result saturation, late event, contradictory
  envelope or disconnect without a fresh EOSE.
- Each relay restart clears its old comparison epoch and immediately removes
  the signature-eligible checkpoint until all sources have been rechecked.
- The original *signed* `9597` events remain available as evidence even when
  a checkpoint becomes unavailable. A disconnected relay does not delete
  historical votes or grant permission to re-sign.
- `historicalReconciliationConflicts` reports alternative checkpoint/source
  hashes, duplicate member signatures, inconsistent IDs, malformed evidence
  and stale revisions, with bounded samples (max eight), but NEVER resolves
  a conflict automatically or modifies balances.
- Current-member and former-member UIs show relay decision status and the
  reasons for conflicting signed statements. The archive remains audit-only.

## Still out of scope

- Detecting a globally omitted event from relays that all censor identically.
- Treating EOSE or relay agreement as completeness or settlement finality.
- Superseding a signed checkpoint or legally releasing debt. Any supersession
  needs a separate versioned consensus rule and explicit signatures.
- Actual Lightning payments; real funds remain inappropriate for acceptance.

`safeForPayments` and `completeHistory` remain **false**, including after
unanimous acknowledgment. The old financial lock is not changed.

## Test commands

```bash
npm ci
npm test
npm run test:e2e
npm run build
npm audit
npm audit --omit=dev
git diff --check
```

No release should proceed without browser regression and a security review of
real NIP-07 signers and relay disconnects.
