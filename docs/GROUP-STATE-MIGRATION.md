# Phase 1B — Scoped group state and cache quarantine

Base: `fix/author-scoped-groups-phase1a-v2` (includes Playwright E2E).

## What changes

- The app identifies each visible group by the full Nostr address `30001:<owner>:<d>`, not by `d` alone. Groups whose owners choose an identical `d` are separate entries, subscriptions and write destinations.
- When a signed group definition arrives from the relay, the store indexes it by the author-scoped address. Legacy transactions without `a` can be used only while one matching group has been discovered. If another owner later provides the same `d`, unscoped transactions previously applied are **quarantined from the balance**; the UI displays a warning.
- Group subscriptions include the owner in their REQ identifiers. Parsers still check the signed `a` tag. A transaction for another group with the same `d` cannot update the wrong group's balances.
- On login/refresh **cached groups are no longer hydrated as verified financial state**. The app reconstructs them from signed relay events; offline groups may appear empty until relays respond. Old account-scoped caches are retained, not deleted, as legacy backup. Profiles still use account-scoped cache; the signed outbox and Lightning payment journal are unchanged.
- **Payment journal keys deliberately remain in the old raw `d` scope** so that an existing persisted guard cannot be bypassed by introducing new owner-scoped group references. This may conservatively block a payment in another colliding group. Do not migrate locks without an explicit migration protocol.

## Limitations — do not treat as production-ready with funds

- Old Nostr events without `a` **cannot be attributed cryptographically** when multiple authors use the same `d`. If a collision is unknown because a relay is offline or incomplete, an unscoped event may be temporarily shown. Reconcile balances with recipients before paying; don't rely on a local snapshot alone.
- Historical membership cannot yet be fully reconstructed: addressable `kind:30001` revisions on public relays might be superseded. Previously removed members' signed transactions may be unavailable or rejected by current-membership filters. A stronger immutable revision protocol and associated replay tests are required (Phase 1C).
- A member can still create unapproved expenses attributed to another member; invite consent and expense approval remain separate phases.
- Signed relay events do not prove Lightning transfer. Require payee verification and confirmation, independently.
- Public event payloads remain public; encryption/privacy requires a separate protocol and migration.

## Acceptance

Run `npm ci && npm test && npm run test:e2e && npm run build && npm audit && npm audit --omit=dev && git diff --check` with `payload/` moved out of the repository (Node's test discovery includes `payload/tests`).

Additional Playwright test exercises two signed group creators sharing one `d`, a legacy unscoped transaction, correct account-to-group routing, and cross-group isolation.
