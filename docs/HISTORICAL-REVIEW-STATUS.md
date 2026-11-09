# 2E-F-C — Non-binding historical review status and evidence index

Phase 2E-F-C **concludes the read-only review workflow**, not the underlying
historical debt. It adds **no new Nostr event kind**, financial mutation,
Lightning transfer, release of `_financialReviewRequired`, or waiver authority.

## Review states (not payment states)

| State | Meaning | Permitted consequence |
|---|---|---|
| `unavailable` | No verified historical reconciliation and draft | Read-only warning |
| `unsynchronized` | Some required relay epoch has not matched EOSE | Read-only warning; wait for observations |
| `pending` | Verified draft but some independent reviews missing | Only existing 9598 opt-in review may be signed |
| `disagreement` | Distinct historical participants signed different draft modes | Stop and request manual review; no majority rule |
| `conflict` | Duplicate signers, conflicting IDs, invalid evidence or explicit conflict | Fail closed, keep all signed evidence |
| `review-recorded` | All historical participants selected the same 9598 **preference** | Create a local read-only evidence index, never an effective waiver |

States are projections of **locally observed** evidence and can regress from
`review-recorded` if new events are observed, a relay disconnects, the current
revision changes, or verification becomes unavailable. Never store them as
immutable financial truth or claim global completeness.

## Evidence record

Only after both 2E-F-A drafts are **recomputed** from an unchanged, unanimous
9597 checkpoint, the 9598 summary is unanimous, and all three relay audits
(source financial events, 9597 reconciliation, 9598 preferences) agree on their
own observed EOSE snapshots, produce SHA-256 over deterministic JSON with:

- Version 1, domain `index-observed-historical-review-v1` and full owner-scoped
  group address.
- Exact current revision, attested source snapshot and reconciliation hash.
- Selected **non-binding** draft mode and hash.
- One signature-verified 9598 event ID per historical member (including removed
  members), sorted by participant key; repeated identical IDs are deduplicated.

The receipt is a **local fingerprint of evidence**, not a Nostr-signed verdict,
not a transferable claim, not legal proof of debt release, and not a payment.
The underlying Nostr events must remain available to verify the fingerprint.
If all configured relays omit the same event, a matching audit may still be
incomplete. Record hashes have no network-wide finality.

## Invariants and future requirements

Every returned state and record always has `effective=false`,
`safeForPayments=false`, `completeHistory=false`, `legalWaiver=false`.
Never mutate operational balances, settlement or confirmation state. A future
legally meaningful waiver would require a **separate**, deliberately scoped,
versioned and encrypted consent/authorization protocol, security review and
jurisdiction-specific analysis, not reuse of 9598.

The existing 9598 preference events are **public and unencrypted** on current
Nostr relays. Test using disposable identities and fictional amounts only.
Do not use real financial information or actual Lightning funds for acceptance.

## Regression checks

```sh
npm ci
npm test
npm run test:e2e
npm run build
npm audit
npm audit --omit=dev
git diff --check
```

Manual acceptance: use current and removed-member accounts; inspect pending,
disagreement, conflict, unanimous-review fingerprint, relay disconnect and
reconnect, and new-revision invalidation. No wallet activity should occur.
