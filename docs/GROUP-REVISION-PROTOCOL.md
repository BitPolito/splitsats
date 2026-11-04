# Phase 1C — Immutable, signed Nostr group revision ledger

Branch basis: `feat/author-scoped-store-phase1b` (which includes 0 + 1A + 1B). No Vercel changes.

## Protocol (custom application event kind)

- `kind:30001` remains the **replaceable** group definition for discovery. A new definition has `revisionEventId` in signed JSON and matching `['r', revisionEventId]` tag. A legacy definition has neither.
- `kind:9591` is a **regular, immutable** revision (application-specific `9591`, distinct from NIP-29 moderation kinds). Only the group owner may sign it. Signed JSON: `{groupId, version, previousRevisionId, members}`. Genesis has version 0 and null predecessor; later revisions link the exact previous event ID with `e` tag. The `a` tag names `30001:<owner>:<d>`, the `g` tag contains `<d>`, and `p` tags exactly match members. Signature verification is performed by `RelayPool` before parsing.
- New financial events (`kind:9000`, `9001`, `9002`) include signed `r` tag naming the immutable revision whose membership authorized their content. The `a` binding from 1A remains mandatory for author-scoped routing. Events referencing an unknown revision are excluded.
- New group creation publishes immutable genesis **before** the replaceable definition. Both go through the persisted Nostr outbox and require ACK. Pending immutable genesis and pending group definitions share a creation lock; replay existing signed IDs before attempting another group. If genesis was ACKed but definition was never signed, genesis is an orphan, not a recoverable group: no automatic resume exists yet. Do not claim it was completed.
- A history is accepted only if a complete, nonforking chain reaches version 0 and its last member list matches the signed `kind:30001` head. Relay omission leaves the group **incomplete**, not empty and settled. Conflicts quarantine the whole ledger.

## Financial fail-closed rules

- If the head is missing, ancestry is incomplete, or the chain forks, the UI **does not calculate/display** a zero debt as "all settled". New expenses, payments and recipient confirmations are blocked.
- Historic transactions are validated against the exact signed `r` revision; union-of-members subscriptions can fetch events from removed members, but a later roster change cannot retroactively authorize an unrelated account.
- **Any member removal requires manual reconciliation**: the existing net-balance engine operates on the current roster, so excluding a historical debtor/creditor can hide obligations. This patch blocks the group's financial actions until an explicit ledger-aware migration is implemented; it does not silently zero removed members' debts.
- **Legacy groups** lacking `revisionEventId` remain readable and usable for compatibility, but show an explicit historical-verification warning. They do **not** acquire a fictitious genesis automatically. A later owner-approved migration must decide how to handle legacy balances.
- Outbox and durable payment attempt journal remain unchanged, including the conservative old raw-`d` journal scope. A relay ACK never proves Lightning settlement.

## Limits and remaining work

1. There is not yet a UI for editing membership or publishing versions greater than 0. The parser/chain resolver supports later immutable versions; the writer currently creates genesis only.
2. Nostr `created_at` is **signer-controlled**. A removed malicious member might backdate a transaction referencing an older revision. The signed revision reference makes history auditable but is not a trusted timestamp or strong revocation mechanism. For adversarial membership changes, require independent approvals or a stronger epoch/finality protocol before transferring funds.
3. Public relays may omit or prune immutable events, or return incomplete EOSE snapshots. "Verified" means the fetched chain is internally consistent, **not** globally complete or economically final.
4. Current financial records on legacy groups are *not* automatically migrated or re-attested.
5. Events on public relays are public. This patch does not encrypt group/expense data, prove real wallet payment, or replace multi-device tests with real signers/relays.

## Validation

`npm ci && npm test && npm run test:e2e && npm run build && npm audit && npm audit --omit=dev && git diff --check`

- Existing tests from phases 0, 1A and 1B must remain green.
- New Node tests cover valid genesis, complete chain, missing ancestor, fork, membership changes, malformed tags and transaction `r` binding.
- Browser tests additionally cover complete two-user flow and a signed group whose referenced immutable history cannot be found: no misleading "all settled" screen and no new financial actions.

## Kind namespace caveat

Legacy SplitSats expense/settlement kinds 9000–9002 collide numerically with NIP-29 moderation kinds on some relay implementations. These existing kinds are not changed by this compatibility patch; a future versioned protocol migration should move them to a documented, conflict-checked namespace. The newly introduced revision kind 9591 is deliberately outside the NIP-29 moderation range 9000–9020, but this is an application convention, not an officially reserved kind.

## Local creator acknowledgment race (Phase 1C hotfix)

The creator has already published both signed events and parsed its own immutable
genesis before adding the group to the in-memory store. `mergeVerifiedGroup()`
creates new groups in the conservative `pending` state, by design, since relay
metadata alone cannot prove a complete immutable history. For the **creator
only**, the store now restores `verified` using the exact signed group event ID
and immutable revision ID; it never trusts cache data for this transition.
This avoids a race where the author's own relay echo arrives after local insertion
and is discarded as a duplicate. Other clients continue to require relay
history validation, and refresh resets the ephemeral trusted state.
