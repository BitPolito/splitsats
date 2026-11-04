# Phase 2A — explicit, signed group invitations

This is a **breaking behavior change for newly created groups**; older groups remain in legacy mode and must not be represented as opt-in groups.

## Protocol

- Group creator signs and publishes immutable revision `kind:9591`, genesis `version:0`, with `consentPolicy:"signed-invites-v1"`. The group definition (kind:30001) commits to the exact genesis event ID. This is a signed protocol-level opt-in, not just a mutable UI flag.
- An invitee sees the group but is **not an active financial participant** merely by appearing in its `p` tags. Every non-owner member must send one signed, ordinary event `kind:9592` with `decision:"accept"` or `"decline"`, bound to the author-scoped group (`a`), group ID (`g`), exact immutable revision (`r`), owner (`p`), and application tag `t:splitsats`. The event's signer must be the invitee.
- A decline freezes the group for new financial actions; the owner must form a new group rather than silently deleting a declined invitation. Multiple different decisions from the same invitee are a conflict, not last-write-wins.
- Before all invited members accept, creating expenses, settlements, confirmation receipts and wallet submission are blocked. Balance panels cannot claim "all settled" while consent is pending.
- Each subsequent expense/settlement/confirmation includes the **exact signed acceptance event IDs** in `i` tags, one per invitee, in canonical pubkey order. Relayed financial events missing or altering these tags are excluded from this group. The group revision `r` tag is still mandatory.
- Invitation EOSE is only a loading signal, **not proof of absence or finality**. A relay can omit events. The signed event log is replayed on refresh. A timeout never means that an invite or payment was not submitted: retry the existing signed outbox entry.
- The owner implicitly consents to their own invitation, but **does not sign for another member**.

## Safety and limitations

- Invitation consent is **NOT consent to any particular expense** and is not proof that a payer paid. The next phase should add per-expense acknowledgment/dispute; no Lightning funds should be used yet.
- The solution is intentionally conservative: a changed membership revision requires new signed decisions. Old revision receipts do not carry over automatically. The historical revision reconstruction and member-removal review gates from phase 1C remain in place.
- Signed Nostr timestamps are not verifiable wall-clock time. The `i` references prove *which receipt event IDs* the writer knew, not the real-world moment of consent. Clients must reconcile with participants before trusting large balances.
- Relays may withhold conflicting signed decisions. A split-brain relay view can temporarily show accepted when another relay has a contradictory event. Financial safety against malicious relays requires independent relay diversity/checkpoints or stronger consensus.
- Public relay payloads are visible to observers. No encryption is claimed or introduced here.
- The payment-attempt journal intentionally stays keyed by the old group `d` value to avoid bypassing pre-migration anti-double-pay locks.

## Tests and review gate

Run `npm ci && npm test && npm run test:e2e && npm run build && npm audit && npm audit --omit=dev && git diff --check`.

Playwright tests simulate a local relay and signed NIP-07 clients, with no real Lightning payments. They verify the two-client accept-before-expense flow and a rejected invitation persisting after refresh. Check `kind:9592` and `i` tags in the signed event log.

No auto-merge until all tests pass and `dev` is checked again for upstream changes.
