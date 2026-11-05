# Phase 2E-E-A — explicitly signed historical reconciliation proposal

## Why it is distinct from phase 2E-C

`9596` attestations only say **which historic data was observed**. They do not
acknowledge a debt. Phase 2E-E-A introduces an explicit second action: all
historic participants, including former members, may sign the same proposed
net-vector checkpoint, after separately attesting the same snapshot.

This is an application-level acknowledgment of the proposed numbers, **not**
a Lightning receipt, proof of global history completeness, economic finality,
legal discharge of debt or payment authorization. The old financial lock must
remain in force, including after unanimous agreement.

## Preconditions (fail closed)

- Complete signed immutable membership chain and confirmed financial-history
  observation, including all historical and current participants.
- Prior financial replay is `observed`, has a balanced vector of *integer satoshi*
  amounts for precisely the historical roster (limit: total Bitcoin supply).
- All roster participants signed the same original historical **snapshot**
  attestation (`9596`). Any missing or contradictory attestation blocks this.
- Configured relay sources (at least two) have all EOSE-completed with exactly
  the same *observed* event IDs and envelopes, none saturated, conflicting,
  overflowing, or changed after EOSE. This does **not** prove completeness.
- The current group's historical financial lock is still set.
- The signer has reviewed the displayed amounts and explicitly checked consent.
- All configured relays have completed initial EOSE for the new reconciliation
  decision subscription (still not proof that no conflicting events were omitted).
- No unresolved outbox events; uncertain publication requires retrying the
  exact already-signed ID (never sign a duplicate operation).

## Signed data

Custom immutable `kind:9597`, using the existing NIP-07 signer, verified in
`RelayPool` before protocol parsing. The signed event has unique tags
`g=<groupId>`, `a=30001:<owner>:<d>`, `r=<current revision event ID>`,
`x=<checkpoint SHA256>`, `t=splitsats`, plus a `p` tag for every historical
participant. Signed JSON has exactly:

```json
{
  "version": 1,
  "action": "acknowledge-reconciliation-v1",
  "groupId": "...",
  "revisionEventId": "...",
  "snapshotHash": "...",
  "checkpointHash": "..."
}
```

`checkpointHash` is SHA-256 of a canonical JSON object committing to the
version, explicit action, full owner-scoped group address, current revision
head, *attested* source snapshot hash, sorted historical participant pubkeys,
and the exact integer signed net vector in that same order. Amounts themselves
are not repeated in each event; they are reconstructed from verified history.

Each signer may sign once per checkpoint. Identical event IDs are deduplicated;
a duplicate member statement, a different hash, or a divergent signed envelope
is treated as conflict. A new head invalidates the checkpoint.

## Operations intentionally NOT enabled

- No `expenses`, `settlements`, `confirmations`, current balances or
  `_financialReviewRequired` changes.
- No debt transfer, release, automated wallet transaction, or settlement
  finality. The current UX remains locked for uncertain historical balances.
- No global consensus: a censored subset replicated on every queried relay
  could still look identical. Real-funds decisions need an independently
  reviewed release protocol and wallet evidence.
- Former-member access remains in the dedicated *audit-only* archive session;
  it never reintroduces a removed member into active groups.
- Legacy/unsigned historical revisions and incomplete relay snapshots are not
  silently upgraded or reconciled.

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

Require browser regression and real NIP-07 signer smoke tests with test
accounts before merging; **no Lightning payments** in acceptance testing.
