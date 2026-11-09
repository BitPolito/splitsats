# SplitSats phase 3A — signed Nostr payload compatibility matrix

## Scope and risk boundary

This phase adds a **reader compatibility gate**, NOT a format migration or a
release of the historical financial lock. Every received event MUST first pass
Nostr Schnorr signature verification in RelayPool. Application parsers then
check the payload schema AND their existing identity, tags, revision and
financial authorization invariants.

The signed `content` of existing Nostr events must NEVER be rewritten in place.
A rewritten event has a different ID and signature; migrating by transforming
an old signed event would destroy its evidentiary meaning. Any eventual new
format will need a new explicitly signed event and a cross-format replay plan.

## Exact existing kind inventory

| Kind | App meaning | Signed `content.version` today | Reader behavior |
|---|---|---|---|
| `30001` | group definition (addressable) | not a schema version | missing `schemaVersion` = legacy |
| `9000` | expense proposal | not a schema version | missing = legacy |
| `9001` | debtor settlement claim | not a schema version | missing = legacy |
| `9002` | recipient receipt confirmation | not a schema version | missing = legacy |
| `9591` | owner-signed membership revision | **membership sequence index**, starting at 0 | keep prior semantics |
| `9592` | invitee consent | not a schema version | missing = legacy |
| `9593` | expense approval/dispute | not a schema version | missing = legacy |
| `9594` | expense cancellation | not a schema version | missing = legacy |
| `9595` | voluntary exit | not a schema version | missing = legacy |
| `9596` | snapshot attestation | **action payload version 1** | exact immutable v1 shape |
| `9597` | historical net reconciliation | **action payload version 1** | exact immutable v1 shape |
| `9598` | non-effective preference | **action payload version 1** | exact immutable v1 shape |

NIP-01 kind `0` profile metadata is **not** a custom SplitSats kind. Do not
apply SplitSats payload-version restrictions to other Nostr applications.

## New reserved field

`schemaVersion` is a **top-level JSON content field** distinct from existing
`version`.  Phase 3A reserves it for forward-compatible new payloads for
`30001`, `9000`–`9002`, `9591`–`9595`. For these kinds, the reader accepts
missing `schemaVersion` as legacy, and an explicit integer `schemaVersion: 1`
only if the *existing application parser* still authorizes the payload. It
rejects `schemaVersion: 2`, strings, `null`, negative/fractional versions, and
the ambiguous `protocolVersion` alias. It never injects the field into old
signed bytes, and the current writer still emits the preexisting format.

For `9596`–`9598`, the already deployed exact v1 payload key set is immutable;
**do not add `schemaVersion` to those signed formats**. Their existing
`content.version: 1` is retained, and any incompatible new action needs a
separate migration/new kind.

The version gate is **necessary but not sufficient** for authorization. It is
not a network-wide proof that a future or omitted event never existed. Relay
snapshots and EOSE remain incomplete observations, even if matching.

## Security and rollout rules

1. Signature validation remains before every parser. The gate never alters
   signature validation, group membership, replay, wallet attempts or outbox.
2. Unknown future versions of the financial and mutable membership payloads
   must not be downcast into legacy financial records.
3. Keep historical signed event IDs and old payload bytes; never replace them
   with unsigned local migrations.
4. An incompatible newer group definition, Nostr kind or schema is NOT proof
   that the group has no debts. **Do not rely on this phase alone to reconcile
   such a group:** 3B must add explicit unsupported-version quarantine and
   account-wide relay-era migration diagnostics before real funds are enabled.
5. `9000`–`9002` numerically collide with NIP-29 relay-based-group moderation
   kinds. Phase 3A does **not** renumber them or re-sign old claims. Plan a
   collision-free namespace migration in phase 3B, preserving old-claim
   references, consent receipts and historical hash commitments.
6. `kind:9598` choices are still published in plaintext on public relays.
   Use only throwaway identities and synthetic financial data until encrypted
   protocol and independent security review are implemented.
7. The historical non-executive review record from 2E-F-C remains nonbinding.
   `safeForPayments=false`, `completeHistory=false`; no automated debt waiver.

## References

- NIP-01: https://github.com/nostr-protocol/nips/blob/master/01.md
- NIP-29: https://github.com/nostr-protocol/nips/blob/master/29.md

## Acceptance on an updated `dev` branch

```sh
npm ci
npm test
npm run test:e2e
npm run build
npm audit
npm audit --omit=dev
git diff --check
```

Do not test with real money. Confirm this phase on a pair of disposable NIP-07
identities, as neither test EOSE nor relay ACK proves financial finality.
