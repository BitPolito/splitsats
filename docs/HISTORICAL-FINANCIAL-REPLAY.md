# SplitSats — Phase 2E-B: observed historical financial replay

## Purpose

Rebuild a **read-only simulation** of finances for older signed membership
revisions after 2E-A's bounded historical evidence index. This is not a final,
spendable balance, and it cannot lift the 2D-B / prior-history finance lock.

## Inputs and assurance boundary

Only Nostr events that the existing `RelayPool` has signature-verified are
accepted by the store collector. The replay function independently checks the
owner-scoped group address, event kind, unique `r` revision tag, author within
the roster of that exact revision, and the signed event timestamp against the
immutable revision windows. It uses the existing per-kind parsers to validate
payloads and tags.

The historical subscription additionally retrieves `kind:9592` signed
invitation decisions for old heads. These are not financial transactions and
must not themselves freeze a newly revised empty group. For old revisions with
observed financial activity, the engine verifies unanimous acceptance and
transaction-specific `i` receipt tags, approved `kind:9593` decisions and
`kind:9594` unanimous cancellations. Settlement claims (`9001`) count against
net balances **only** when a matching payee-signed confirmation (`9002`) is
also present. Unapproved proposals, disputes, missing receipts, unconfirmed
claims, conflicts, duplicate logical operations, or integer overflow prevent
any aggregate observed balance from being displayed.

Each older revision is replayed against its original roster. Net results are
then accumulated across the union of historical and current members. Former
members are never silently removed from this diagnostic output. The
`observedNet` output is deliberately `null` whenever replay is incomplete.

## Non-goals and serious limits

- No automatic settlement, debt forgiveness, member removal with actual debt,
  debt transfer, Lightning retry, current-balance mutation or financial unlock.
- **Nostr `EOSE` is not network finality or completeness**. A relay may omit
  events or return a capped result set; even status `observed` means only
  *what the client happened to see*. No production-payment decision may rely
  on this diagnostic.
- The index is bounded to 600 signed envelopes, each at most 16 KiB. The 2E-A
  evidence index remains separately capped at 500 entries. Any overflow is
  sticky, blocks finance and invalidates the replay estimate.
- Old unsigned/legacy membership protocols remain `unsupported`. They must
  not be conflated with modern signed approvals.
- Signed claims and receipts attest to participants' statements; they are not
  cryptographic proof of a Lightning settlement.
- The signed envelopes are public Nostr data; locally cached copies are
  **never** trusted for session restoration. On restart the relay snapshot is
  rebuilt after NIP-07 signer revalidation.

## Next stage

Design a **multi-party signed reconciliation checkpoint** with explicit
provenance, all historical participant consent, proof of completeness from
independent observers, and explicit mapping of debts that remain outstanding.
Until then keep real Lightning payments disabled for revised groups with
observed historical activity.

## Validation

From project root, after applying this patch to 2E-A:

`npm ci && npm test && npm run test:e2e && npm run build && npm audit && npm audit --omit=dev && git diff --check`

Added 12 unit tests. No new Playwright suite test is claimed; existing browser
regression tests must pass on the real repository. Isolated tests are not a
substitute for full application/relay tests.
