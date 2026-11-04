# SplitSats — Phase 2D-A (safe subset): additions to empty groups

## Supported operation

The **group creator** may add an Nostr public key to a verified group, but ONLY
if **no financial activity has ever been observed** on its reconstructed ledger.
This subset does **not** implement unilateral removal, exit or redistribution of
existing obligations. Changing membership in a group with existing proposals,
expenses, settlement declarations, confirmations, expense decisions or signed
cancellations is blocked.

The client requires all current signed invitations to be accepted, the complete
signed revision chain reconstructed, a known-empty durable outbox, and initial
EOSE callbacks for the five financial streams. **EOSE is a weak synchronization
indicator, NOT proof that a relay has delivered all signed history.** The
protocol is not suitable for real Lightning funds without additional review.

## Signed flow

1. Owner validates the prospective member's npub or lowercase hex key and
   proves locally that all above preflight checks pass; no prior removal may
   exist in the revision chain. A definition with a same-second timestamp is
   not permitted, avoiding NIP-33 ambiguous replacement ordering.
2. Owner signs/publishes a new immutable `kind:9591` with `version+1`,
   `previousRevisionId=<old-head>` and an additive member set.
3. Owner signs/publishes the `kind:30001` group definition, with exactly one `r`
   tag pointing to the new immutable revision and the new `p` roster.
4. Previously invited members **and** the newly invited member must issue new
   `kind:9592` acceptances referencing the new signed revision. The creator
   consent remains implicit. Until everyone accepts, financial writes are
   blocked. New expenses carry only the new consent receipts.
5. The immutable chain remains replayable on refresh. A separate subscription
   monitors older revision IDs for financial records. Observing any older
   signed financial activity blocks further ledger operations for manual
   reconciliation; it must NOT silently be discarded when current-head
   invitation receipt checks reject old-head data.

Publication uses the existing durable outbox. On an uncertain Nostr ACK, do
not start another addition or retry by re-signing; resend only the exact
already-signed event from the outbox. A partial two-event publication may
require manual recovery.

## Deliberate limitations

- No member removal, voluntary exit, or post-expense addition. Those require a
  cross-revision ledger and explicit debt transfer/reconciliation protocol.
- This is client-side best-effort safety only; a malicious/omitting relay may
  withhold relevant old events even after EOSE. Multi-party signatures and
  independent relay observation are not network finality.
- Financial history is public on Nostr; this change does not implement privacy
  or cryptographic proof of the absence of earlier expenses.
- Group replaceable definition is still author-owned; another member cannot
  unilaterally amend the roster.

## Test

`npm ci && npm test && npm run test:e2e && npm run build && npm audit && npm audit --omit=dev && git diff --check`

Expected on the PR #21 base: **156 Node tests** and **9 Playwright tests**.
Do not use real Lightning funds during acceptance tests.
