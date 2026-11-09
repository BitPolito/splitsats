# SplitSats v1.0 · Phase 3B-B — mixed financial-kind observation and quarantine

This phase MUST follow 3B-A (the parser-only introduction of provisional kinds
`9600`/`9601`/`9602`). It deliberately does **not** publish v2 events or apply
v2 finance to live or historical balances.

## What is observed

- A separate, signature-verified group/revision-scoped relay subscription reads
  kinds `9000`, `9001`, `9002`, `9600`, `9601`, `9602` together, bounded to 500.
- A pure `FinancialKindQuarantine` groups events by the signed author, financial
  event family and application operation ID. Different signed event IDs claiming
  the same operation are a conflict, particularly across old and v2 kinds.
- Re-delivery of the exact same signed event ID is idempotent. An incompatible
  signed envelope, unauthorized participant, malformed payload or ambiguous
  group/revision scope triggers quarantine.
- Every observed v2 financial event causes quarantine, even when its schema
  is valid: old and new clients MUST NOT independently book the same debt.
- Per-relay snapshots are also audited. Contradictory signed envelopes,
  overflow and query saturation cause sticky quarantine. **For the LIVE
  current-head subscription only**, new valid events arriving after EOSE and
  temporary differences in relay propagation are expected and are diagnostic,
  not permanent quarantine triggers. This differs intentionally from the
  immutable historical-snapshot reconciliation protocol: its fail-closed
  post-EOSE rules remain unchanged. Neither audit proves completeness.
- Old-head history subscriptions now *also retrieve v2 kinds*. Current replay
  cannot yet safely interpret them, so it marks the history incomplete and
  retains the financial review lock rather than skipping them as nonexistent.

## Financial boundary

Quarantine is sticky for the signed current revision. The live store immediately
clears active financial arrays and sets `_financialReviewRequired` plus
`_financialMigrationQuarantine`. Its balance view and spending controls stay
blocked, its current financial subscriptions are stopped, and the existing
membership/exit history barrier cannot remove the lock.

**A newer signed revision does not erase historical obligations.** Its own
quarantine flag is reset so that the new head can be inspected, while the old
revision's v2 financial events will still be found by the prior-revision
subscription and lock that new head if history is unsupported.

Quarantine does not delete signed events on relay or in the durable outbox,
does not mutate balances as an authorized settlement, and does not prove
Lightning payment, debt release, global event completeness or network finality.

## Rollout constraints

The old `9000-9002` writer remains unchanged. The 3B-A v2 parser is only used
for *diagnostics* here. The 3B-C writer transition MUST NOT ship without
an explicit group opt-in/migration policy, protection for older clients,
per-relay history support, and multi-device tests. In particular, a legacy
client cannot see future v2 events and MUST NOT be relied on for real funds.

This patch intentionally favors false-positive lockouts over risking financial
state divergence. It does not claim completeness of historical relays, legal
finality of any agreement, or production readiness for real funds.

## Verify

```sh
npm ci
npm test
npm run test:e2e
npm run build
npm audit
npm audit --omit=dev
git diff --check
```

Manually smoke-test two NIP-07 accounts and a simulated divergent relay set.
Do not publish synthetic v2 events to public relays or use real satoshis.
