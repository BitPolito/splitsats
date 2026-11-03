# Group identity and historical membership — Phase 1A

## Why this is staged

Existing SplitSats events identify groups by the unscoped `g: <d-tag>` convention. A Nostr addressable group is in fact the triple `(kind=30001, author, d-tag)`. Two authors can intentionally choose the same `d` and unrelated expenses can therefore be misattributed if clients use only `d`.

This phase adds **pure safety primitives** (`src/lib/group-history.js`) and guards against mismatched `a` tags in the three transaction parsers. It does not yet change the app's group cache, subscription IDs, or generated transaction tags. **It is not a full fix for existing legacy collisions.**

## Protocol migration — next Phase 1B

- This Phase 1A now emits `['a', '30001:<author>:<d>']` alongside `['g', d]` for new expense (`9000`), settlement (`9001`) and confirmation (`9002`) events. The second phase will enforce that binding in routing, caches and subscriptions for all group instances.
- Cache groups indexed by `30001:<author>:<d>` and migrate existing account-scoped caches only after retrieving signed definitions from relay; do not infer the owner from an unverified cache.
- For groups with identical d-tags, legacy events lacking `a` are ambiguous and must not be used to calculate balances unless an independently verifiable migration resolves them. **Never automatically assign by actor membership or first arrival.**
- Group revisions can change membership. Reconstruct the membership applicable at the signed event timestamp; conflicting changes with identical timestamps must remain ambiguous.
- User-created timestamps are not trusted wall-clock time: historical membership reconstruction is a consistency model, not proof that an attacker did not backdate a signed event. A stronger epoch or causal reference protocol is needed before claiming adversarial membership safety.
- The existing cache is only a hint. To display an authoritative balance, rebuild from signature-verified relay events. Outbox and offline recovery must remain account-scoped and intact.

## What this phase changes

- `matchesGroupAddressTag()` rejects malformed, duplicated or mismatched address tags in expenses, settlement claims and confirmations. All new events created by the store include a signed `a` tag. Legacy events without an `a` tag remain accepted by the current parser **until routing is migrated**.
- `resolveGroupAtEvent()` routes parsed signed group histories by author-scoped group address, quarantines colliding legacy events and finds the applicable historical membership revision.
- `cleanVerifiedGroupSnapshot()` deliberately excludes unverified local transactions when preparing a relay-verified group snapshot. Do not use it as a storage migration until the multi-client lifecycle is integrated.

## Testing and release gate

`npm test && npm run test:e2e && npm run build && npm audit --omit=dev && git diff --check`

No real Lightning payments or production rollout until Phase 1B and multi-device regression tests pass. Do not interpret this groundwork as completion of Phase 1.
