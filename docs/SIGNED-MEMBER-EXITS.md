# SplitSats — Phase 2D-B: voluntary exit from financially empty groups

## Scope

A participant can voluntarily **request** to leave a group. The request is a
non-replaceable Nostr event signed by that participant. It does **not** change
the roster. Only the group creator may **finalize** the exit by publishing a
new immutable revision and a new replaceable group definition that both bind
to the exact participant-signed request. All remaining invitees must accept
the new revision before new expenses or transfers.

This initial implementation is deliberately limited to groups with **at least
three members** and an empty, EOSE-observed financial history. Groups with
proposals, expense decisions, disputes, settlements, cancellation decisions,
confirmations, unverified revision history or pending outbox events are blocked.
EOSE is a weak sync barrier, **not proof of absence** of earlier events. Do not
use this for real funds without multi-device verification.

## Signed protocol

- `kind:9595` (regular immutable): author is the exiting participant, not the
  owner. Tags `g` group ID, `a` owner-scoped group coordinate, `r` current
  signed revision ID, `p` owner pubkey, `t=splitsats` are unique. Signed JSON:
  `{ "groupId": "...", "revisionEventId": "<old-head>", "action": "leave" }`.
- Owner publishes a new immutable `kind:9591` with version incremented,
  `previousRevisionId` equal to the old head, one member removed,
  `exitedMember` equal to the requesting signer and `exitProofEventId` equal to
  the request ID, with an exact signed `x` tag naming that same proof ID.
- Owner publishes `kind:30001` pointing via `r` to the new revision. Remaining
  members re-sign `kind:9592` invitations against this exact head.
- During reconstruction, a revision with removed members stays locked until a
  matching signed `kind:9595` is recovered and checked against the immutable
  chain. A late old-head expense triggers financial review; no old balance is
  silently erased. Contradictory or missing exit evidence blocks activation.

## Intentional limitations

- **No forced kick**, no exit by the owner, no exit leaving fewer than two
  members, no second exit after a prior removal, and no modification of groups
  with financial activity. Those require a historical-ledger and dispute/debt
  reconciliation protocol.
- The removed member may still see an old group definition until reload on a
  relay that offers only current addressable events. The removed member's
  signed request is still publicly auditable and **does not prove** that the
  owner has finalized the exit. Client discovery of a removed-member tombstone
  remains future work.
- A malicious or omitting relay may hide old financial events. We cannot prove
  a group is empty or guarantee finality from Nostr relay observations.
- Historical Nostr events remain public and cannot be deleted by changing the
  group roster. Do not interpret removal as erasure or release of obligations.
- Never repeat the original operation after an unknown relay ACK: recover the
  *same signed event ID* from the durable outbox.

## Testing

Apply on a clean branch from `dev` containing PR #22, then run:

`npm ci && npm test && npm run test:e2e && npm run build && npm audit && npm audit --omit=dev && git diff --check`

The 5 isolated protocol tests were run in a Node-only harness. The integrated
Playwright suite must be run against the actual repository on the developer's
machine before any commit/merge.
