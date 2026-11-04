# Phase 2E-C-B — read-only former-member archival attestations

## Why a separate archive

An ex-member is **not** in the current NIP-33 group definition's signed `p`
tags and cannot be safely loaded as an active participant. This feature does
not weaken `parseGroupEvent`, `fetchGroups`, or any store/payment authorization.
Instead, the ARCHIVIO tab maintains an isolated, ephemeral browser-only audit
session, without populating Zustand's active `groups`.

## Audit-only discovery and validation

1. The signer must already have a valid NIP-07 session. RelayPool verifies
   signatures on all incoming events.
2. Discover only that account's own signed `kind:9595` leave requests. A
   strict hint parser verifies the owner-scoped address, old revision, and tags.
   **This is only a locator**, not an authorization.
3. Retrieve the exact owner's signed current `kind:30001` definition by its
   author and `d` tag. Parse it as the owner, not as a forged invitation to the
   departed member. The owner must not currently include the viewer.
4. Verify the full owner-signed immutable revision chain (`kind:9591`), and
   independently signer-verified `kind:9595` exit requests, via
   `verifyMemberExitProofs`. The historical participant's own original request
   must be exactly the ID committed by the owner's later removal revision.
5. Only then subscribe to old-head signed activity, reconstruct the existing
   phase 2E-B observed replay, compute the same 2E-C-A snapshot hash, and
   allow that previous participant to sign the *same* `kind:9596` attestation.

## Fail-closed behavior

- Every archive candidate is reverified on each session. No cached membership
  or amount is trusted; nothing in archive enables add-expense or payment UI.
- Missing ancestors, missing signed exit proof, conflicts, overflows, missing
  approvals or current-head changes invalidate attestation.
- A new signed old-head financial event forces snapshot regeneration. A signer
  cannot send an attestation for a stale cached event array.
- The durable outbox remains authoritative for unknown publication outcomes.
  Never re-sign an uncertain event instead of retrying its exact signed ID.
- This first version supports voluntary, owner-finalized exits that have a
  strict `9595` request. Legacy unsigned removals and lost/omitted relay history
  are unsupported. An ex-member may see no archive if relays omit events.

**Critical:** Nostr EOSE is *not proof of completeness*. Attested means only
that signatures agree on *observed data*. It does NOT release debts, certify
Lightning transfers, alter the ledger, or unlock any payment. Never use real
funds until independent multi-relay completeness checks and settlement rules
are audited.

## Validation

`npm ci && npm test && npm run test:e2e && npm run build && npm audit && npm audit --omit=dev && git diff --check`
