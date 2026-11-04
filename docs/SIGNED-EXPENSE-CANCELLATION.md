# SplitSats Phase 2C — Signed cancellation of disputed expense proposals

## Scope

This phase resolves a **disputed** original expense only by unanimous immutable
signatures from the original proposer, payer, and all split members. No data is
removed from Nostr; the original `kind:9000` proposal and `kind:9593` approvals
or objections stay visible as evidence. A canceled original can be replaced only
by publishing a completely new `kind:9000` proposal with independent approvals.
This phase deliberately DOES NOT implement unilateral editing, retroactive
changes to an accepted payment, or automatic reconciliation of existing
settlements. Legacy groups retain their earlier policy.

## Nostr protocol

Regular event `kind:9594` signed by the cancelling participant:

- Tags `g=<group d>`, `a=30001:<owner>:<d>`, `r=<immutable head revision id>`,
  `e=<original expense event id>`, `p=<original proposal signer>`, and
  `t=splitsats` must match signed JSON exactly and be unique.
- JSON: `groupId`, `revisionEventId`, `expenseEventId`, `expenseAuthor`,
  `action: "cancel"`.
- As for `kind:9593`, verification of the Nostr signature is handled by the
  relay transport **before** the parser receives the event. The parser
  then validates membership, exact group/revision binding and signed fields.
- Each required participant may publish one immutable cancellation per
  original expense; contradictory or duplicate decisions fail closed.
- All signers must be members in the exact revision to which the expense
  is bound. A missing/disputed group revision or conflicting approval history
  cannot be silently resolved.

## Ledger and safety

- Once a signed objection is observed, the group remains locked. Reaching
  unanimous valid cancellations excludes ONLY the original proposal from
  balances; it does not create, edit or pay any other expense.
- The group may be unlocked only if the original expense has a verified
  `disputed` status and **no settlement or recipient-confirmation exists in
  the group**; older settlement records do not identify a specific expense,
  therefore they cannot be reconciled automatically.
- Historical Nostr subscriptions continue to collect signed proposals,
  approvals and cancellations during the lock. All financial writes and
  wallet submissions remain blocked until resolution.
- Cancellations from the Nostr relay are replayed after browser refresh.
  The outbox persists the exact signed event ID before network publication.
- A canceled expense stays visible in the audit UI as **SPESA ANNULLATA**.

## Limitations

Relay omissions mean observing unanimous signatures is not formal finality;
multiple relays may disagree or withhold historical events. This is a
fail-closed *best-effort* protocol, not a guarantee of real-funds safety.
Users should reconcile balances with each participant; real Lightning
payments remain inappropriate until an independent cross-device review,
privacy review, and versioned kind migration are complete.

## Acceptance

From `origin/dev` including PR #20, apply this kit on a fresh branch.
Run `npm test && npm run test:e2e && npm run build && npm audit && npm audit --omit=dev && git diff --check`.
The browser test must show a 2-party dispute, both cancellation signatures,
restored controls, and a separate corrected expense after cancellation.
