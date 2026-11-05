# Phase 2E-F-B — signed non-effective historical disposition preferences

Phase 2E-F-A introduced local previews of two alternatives for an already
unanimously acknowledged historical net vector: retain the historical ledger
separately, or **propose** a mutual waiver. Neither preview transfers or
extinguishes any obligation.

This phase records a **non-binding review preference** about the precise
2E-F-A draft. It does NOT adopt, finalize or execute any waiver or carry-over.
A true debt release requires its own protocol, legal review where appropriate,
and separate authorization; this event does not satisfy those prerequisites.

## Wire protocol

- Custom immutable Nostr `kind:9598`, created only via NIP-07 and placed in the
  durable outbox before network publication; `RelayPool` Schnorr-verifies all
  subscribed events before parsing.
- Exactly one historical participant (including former members with verified
  archive eligibility) signs one draft preference per current revision.
- Content fields exactly `{version:1,action:'review-historical-disposition-v1',
  groupId,revisionEventId,checkpointHash,mode,draftHash}`.
- Tags exactly `g`, `a` (author-scoped group), `r` (immutable head), `x`
  (draft hash), `t=splitsats`, and one `p` per historical participant.
- Modes: `retain-historical-record`, `propose-mutual-waiver`.
- Draft hash comes from 2E-F-A, which checks the original unanimously signed
  9597 checkpoint hash against the exact sorted net vector and revision.
- Signatures from multiple relays with the same immutable ID are idempotent;
  a second distinct signature from the same signer is **conflict** even if the
  mode matches. Different members choosing different modes are **disagreement**.
- A new revision invalidates the draft; an old signed statement never
  silently authorizes the next head. No competing proposal is auto-superseded.

## Fail-closed conditions

Before the app offers a signature, the complete historical revision roster,
attestation and reconciliation chains must be verified. All three independently
recorded source sets — historical financial activity, 9597 reconciliations, and
9598 disposition intents — must have matching *observed* EOSE snapshots on
all configured relay epochs (at least two sources), without saturation,
reconnect gaps, overflow, late events or conflicting signed envelopes.

The app also rejects a pending durable outbox, account changes, a changed
checkpoint/draft, simultaneous signing, over-limit evidence and contradictory
signer rows. It preserves valid signed evidence for later manual inspection.

## Privacy warning / release blocker

These signed `kind:9598` review preferences currently use **public, unencrypted
Nostr relays**. Although the signed content carries only draft/checkpoint
hashes and mode, its `p` tags expose the historical participants and the chosen
position on a potentially sensitive financial decision. Do not enable this flow
for real users or publish real historical financial preferences before the
project's encrypted-data protocol (roadmap privacy phase) is deployed and
security-reviewed. Test with disposable Nostr identities and synthetic data.

## Explicit invariants

**Always:** `effective=false`, `safeForPayments=false`,
`completeHistory=false`.

No mutation to `_financialReviewRequired`, `expenses`, `settlements`,
`confirmations` or spendable balances. No Lightning invoice, wallet call,
acknowledged payment or legal debt waiver is produced by this protocol.
A unanimous `unanimous-review` result means only unanimous **preference**.

Nostr EOSE means initial relay synchronization, NOT network-wide finality or
proof of historical completeness. Censored relays could still agree.

## Verification

```bash
npm ci
npm test
npm run test:e2e
npm run build
npm audit
npm audit --omit=dev
git diff --check
```

Do not use actual funds for acceptance testing. Include NIP-07 signer and
offline-reconnect smoke tests before relying on this for decisions.
