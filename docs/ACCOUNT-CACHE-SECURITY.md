# SplitSats: account-scoped cache and signer validation

The previous browser cache used global `splitsats:groups` and `splitsats:profiles`
keys shared between Nostr accounts. This release migrates them to
`splitsats:groups:v2:<hex-pubkey>` and `splitsats:profiles:v2:<hex-pubkey>`.

- Legacy cache data is migrated only when the saved `splitsats:pubkey` matches
  the account accessing it. Other accounts receive an empty cache.
- Cached public keys are hints, not authentication. On refresh, the app checks
  `window.nostr.getPublicKey()` before displaying stored groups. If the signer
  is unavailable or disagrees, the login page is shown instead.
- Switching signers through login swaps both groups and profiles in one update.
  Late callbacks and outstanding writes from previous sessions may not mutate
  the cache of a different account.
- Logout clears the active account's cached groups and profiles, but preserves
  the separately keyed **signed event outbox**. Pending signed events must remain
  recoverable after logging back in with the same Nostr account.
- The browser cache is **not encrypted**. Group and expense contents published
  on public Nostr relays are still potentially public, including after clearing
  this local cache. Do not use public relays for private financial descriptions.

Tests: `npm test` includes `tests/account-cache.test.js`. To check manually,
create/read groups with signer A, switch to signer B, and confirm no A data is
visible. Reload, reject the signer prompt, and confirm the login screen shows
instead of cached groups. Relog into A and verify the pending outbox is intact.
