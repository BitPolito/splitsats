# SplitSats v1.0 — phase 3B-A: staged financial kind namespace migration

## Problem and decision

Legacy SplitSats `kind:9000` (expense proposal), `9001` (debtor claim),
`9002` (recipient receipt) overlap NIP-29 moderation (`9000` put-user,
`9001` remove-user, `9002` edit-metadata). Different applications on the same
relay do **not** share the SplitSats semantics. We must migrate without
rewriting any immutable signed event IDs or pretending a relay holds complete
history.

**Provisional application-specific regular kinds**, subject to final registry
and relay compatibility review: `9600` expense, `9601` debtor claim, `9602`
recipient receipt. This is not a globally reserved allocation. The v2 signed
JSON must contain `schemaVersion: 2` and an exact `action`:

| New kind | Required action |
| --- | --- |
| 9600 | `expense-v2` |
| 9601 | `settlement-claim-v2` |
| 9602 | `recipient-receipt-v2` |

Required *signed tags* include `g=<groupId>`, `a=30001:<owner>:<groupId>`,
`r=<signed group revision ID>`, `v=2`, `t=splitsats`, plus existing protocol
references: `p`/`e` where applicable. The reader rejects duplicated, absent,
contradictory tags, `h` NIP-29 group tags, bad action, and incompatible schema.
The existing payload fields for amounts, satoshi units and receipt references
retain the same validation and never bypass the debtor/payee signature rules.

## Deliberate rollout order (do not skip)

### 3B-A — reader admission and compatibility (this patch)
- Add the three kind constants and three strict v2 **parser paths**. Existing
  `9000`–`9002` parsing is unchanged.
- The **active app, subscriptions, historical replay, outbox and writer are NOT
  switched** in this step. Nothing emits or consumes a v2 financial event in
  a real group yet. No mixed-version debt calculations are permitted.
- Schema v2 is not allowed on the old kinds, and old unversioned payloads
  are not allowed on new kinds.
- The parser can only be called with events cryptographically verified by
  `RelayPool` or a future equivalent Nostr verifier. Tests use synthetic
  envelopes and exercise post-verification checks only.

### 3B-B — explicit mixed-kind observation and safety gate (future)
- Subscribe to both old/new kinds per group and **all historical revisions**.
- Preserve original signed kind/event ID; never rewrite or impersonate a
  historical signature. Validate old-head invitation approvals and receipt
  references across kinds.
- Observe all connected relay epochs and quarantine unknown v2 and incomplete
  history. Add cross-version duplicate-operation detection and account isolation.
- Block financial writes and display a migration warning until the complete
  supported history has been reconciled. No zero-debt assumption on missing data.

### 3B-C — coordinated v2 writer (future, not enabled)
- Enable v2 publishing only after deployed client-reader capability,
  protocol/replay security review, and mixed-epoch E2E tests.
- Do **not** publish the same operation in old and new kinds. Preserve
  durable outbox on relay timeout; replay only the exact signed event ID.
- For any v2 receipt, refer to the exact signed *claim* ID, legacy or v2.
- Keep payee-signed acceptance mandatory: debtor claim and WebLN wallet
  success do not prove recipient payment acknowledgment.

## Privacy and economic safety

The kind migration does not encrypt data. Financial amounts and participants
still must **not** be used with real identities or real funds prior to the
planned privacy, financial consistency and independent security reviews.
A Nostr relay ACK or EOSE is not proof of globally complete history, wallet
payment or legal debt release. Historical review remains non-executive.

## Acceptance

```bash
npm ci
npm test
npm run test:e2e
npm run build
npm audit
npm audit --omit=dev
git diff --check
```

References:
- https://nips.nostr.com/1
- https://nips.nostr.com/29
- https://github.com/nostr-protocol/registry-of-kinds
