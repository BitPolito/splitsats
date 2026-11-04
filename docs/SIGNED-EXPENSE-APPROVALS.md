# SplitSats Phase 2B — signed expense proposal approval

Base: Phase 2A `feat/signed-group-invitations-phase2a`, applied and committed on top of `dev` SHA `597ad0ad54cafbba7dc3e71c1effc476f65483d7`.

## The new rule

For **new groups only**, immutable genesis `kind:9591` declares `expensePolicy: "unanimous-expense-v1"` in signed content. Old groups without this exact genesis field keep their previous behavior, are not silently retrofitted, and require the existing human reconciliation caveats.

A `kind:9000` signed event is a **proposal**, not an authoritative debt. The required approvers are the payer and everyone whose pubkey is named in `splits`. When the proposal signer is personally in that set, the signed expense proposal is also their own consent to its exact contents. Other required parties sign `kind:9593` decisions (`approve` or `dispute`):

- Nostr tags: unique `g` (`d`), `a` (`30001:<owner>:<d>`), `r` (immutable signed membership revision ID), `e` (expense event ID), `p` (proposal signer), `t` (`splitsats`).
- Signed JSON: `groupId`, `revisionEventId`, `expenseEventId`, `expenseAuthor`, `decision`.
- A decision's Nostr signature is checked by the existing RelayPool; the parser checks kind, author membership, exact signed group/revision/event tags and JSON.
- Unknown, missing or duplicate participant approval does not authorize the expense. Opposed or contradictory decisions prevent treating the expense as an accepted debt.

The store maintains `proposedExpenses` and `_expenseDecisions` separately from `expenses`, and only **unanimously approved** proposals enter `expenses` used by balance calculations. Both decisions and proposals are reconstructed from signed relay history on refresh. If an expense is disputed or its approvals conflict, `_expenseReviewRequired` freezes calculations and financial operations until an explicit future review protocol resolves it. No automatic payments or release of Lightning locks.

### Important limitations

- The new policy applies to groups created after Phase 2B is deployed. A group first created under Phase 2A retains its old genesis and does **not** retroactively gain the policy.
- One or several relays may omit signed events. An observed set of approvals does not cryptographically prove the absence of undiscovered conflicting/declining events. This is an eventual-consistency consistency model, **not finality**. Do not use real Lightning funds based solely on this protocol.
- Published expense and invitation data are **public** unless later encrypted. The current interface does not implement a final dispute resolution or membership removal procedure.
- A unilateral user claim that they paid (`paidBy`) is not treated as an approved payer assertion unless the payer signed the proposal or approved it separately. A confirmed settlement still needs the recipient's separately signed receipt.
- This patch does not change the existing `kind:9000–9002` history, wallet lock scope, outbox retry semantics, or enforce financial safety on third-party Nostr clients. A versioned kind migration, cross-device recovery design and privacy audit are future work.

## Acceptance

First apply, test, commit and push Phase 2A. Create a fresh feature branch based on that commit. Extract the 2B ZIP outside the repository, apply the exact-anchor script, then run:

`npm ci && npm test && npm run test:e2e && npm run build && npm audit && npm audit --omit=dev && git diff --check`

Expected: 2A tests (139 Node, 6 E2E) + 2B tests (5 Node, 1 E2E) = **144 Node, 7 browser** if the actual repository has no extra tests and the test suite passes.

Run no real Lightning payments in CI. Review the security semantics before merging.
