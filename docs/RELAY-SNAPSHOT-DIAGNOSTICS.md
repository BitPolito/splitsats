# SplitSats — Phase 2E-D-B: observed relay discrepancy diagnostics

Extends phase 2E-D-A without relaxing payment or historical safety checks.

## What is reported

- The sorted union of event IDs observed by **EOSE-completed** relay epochs.
  Loading or offline relays are excluded from the union, and are not labelled
  as missing events.
- Each completed relay's `notObservedCount` and a deterministic, bounded sample
  of eight full event IDs that other completed relays returned but it did not.
  Until at least two EOSE-completed sources exist, absent-event counts are unknown.
- Distinct signed envelopes for the same event ID are reported separately
  through `differingEnvelopeCount` and `differingEnvelopeSample`.
- Reconnects clear the old epoch's comparison. Sticky overflow, saturation,
  and inconsistency warnings are unchanged.
- Active-group detail and former-member archive show the same diagnostic view.

This is a read-only aid for manual audit, **not** consensus, a proof of Nostr
history completeness, a Lightning receipt, or an authorization to release debts.
Multiple relays can agree on an incomplete or censored view. `safeForPayments`
and `completeHistory` remain `false` regardless of reported agreement.

## Verification

```bash
npm ci
npm test
npm run test:e2e
npm run build
npm audit --omit=dev
```

Added Node tests cover pending relays, bounded ID samples, envelope differences,
reconnect, late events and unchanged financial restrictions.
