# Phase 3B-D — Non-executing, signed migration review

## Safety contract

This phase adds **kind 9603**, an immutable, signed, group-and-head-bound
expression of preference. It does not upgrade any participant's client,
migrate or republish signed finance events, change balances or permit kinds
9600/9601/9602 to be signed. Writer rejection from 3B-C remains authoritative.

## Wire event

- `kind: 9603` (ordinary immutable, NOT addressable or replaceable)
- JSON contains **exactly** `version:1`,
  `action:"review-financial-kind-migration-v1"`, `choice` (`support-review` or
  `decline-review`), `proposalId` as a fixed protocol string, `groupId`,
  `revisionEventId`.
- Signed tags contain exactly `g`, author-scoped `a`, `r` (immutable signed
  revision), `x` (fixed proposal ID), `v:1`, `t:splitsats`, and one `p` tag
  for each member of the current signed genesis roster (including the owner).
- Signatures MUST be verified with `RelayPool.verifyEvent()` before parsing.
  Additional schema and authorization checks are performed by the pure parser.
- Each verified participant may issue only one immutable signed review
  preference per exact proposal/revision. Two different event IDs from the same
  participant are a conflict, never "latest wins". Exact event replay is
  idempotent. A new revision never inherits old reviews.
- `unanimous-review-observed` is only a label for matching relay observations
  of the signatures in this process. **It is not a consensus certificate or
  proof of global completeness, relay permanence, participant software
  versions, economic/legal finality, safe payments or an effective migration.**

## Eligibility

- Verified **genesis-only** signed group and matching current member list.
- Current signed invitation/expense policies and locally accepted invitations.
- All known local financial arrays must be empty, no previous financial
  activity or quarantine, no missing local sync barriers and an empty outbox.
- Member's NIP-07 signer and active account must match before signing.
- Quorum is separate from normal invite acceptance and expense approvals.
- A missing/out-of-sync relay keeps the review `pending-relay-audit`;
  duplicate/replayed conflict or malformed signed kind9603 evidence is flagged.
- Live 9603 preferences may arrive after EOSE; this is ordinary streaming, not
  an automatic conflict. Contradictory signatures and divergent relay views
  still remain blocked.

## Privacy and rollout

These are **PUBLIC, UNENCRYPTED** Nostr events. A browser confirmation checkbox
explains that they disclose public keys, group locator and review choice.
Do not use production accounts or real identities/obligations while privacy
is unresolved. In particular do not treat 9603 as legally effective consent
for debt discharge or future real funds.

## Next phase

Version adoption requires an explicit versioned group policy, protection for
old client implementations (which cannot see 9600–9602), independent cross-device
verification, secure multi-relay history and human review. These are **not**
delivered by 3B-D. Never auto-promote an observed set of 9603 events into live
finance, and never silently reinterpret legacy 9000–9002 events as v2.
