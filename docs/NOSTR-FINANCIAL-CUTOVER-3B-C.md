# SplitSats Phase 3B-C — read-only financial v2 cutover preflight

This phase follows 3B-B's live mixed-kind observer and quarantine. It does NOT
migrate or dual-publish existing signed events, does NOT enable kinds
9600/9601/9602, and does NOT unlock any financial ledger. It adds an explicit
write-denial in `publishEvent()` so an accidental future call with a v2 kind
fails **before signing or writing to the durable outbox**.

## Cutover safety contract

- The **legacy kinds** 9000/9001/9002 are still parsed and written as before.
  The new kinds remain read-only quarantine evidence.
- The preflight examines a current, verified, signed *genesis-only* revision,
  current signed-consent policies, a locally observed legacy history barrier,
  known financial arrays (including proposed and disputed operations), the
  existing quarantine and the exact account-scoped pending outbox.
- Any actual financial operation (including activity visible ONLY on peer reports),
  unverified account, former-member chain,
  pending event, dispute, unknown history state or quarantine blocks cutover.
- Client reports are intentionally compact *unsigned, local observations*.
  They are NOT independently authenticated, cannot establish relay history
  completeness, and DO NOT prove that a different device is using the new
  software. `matching-observed` means only two supplied reports agree.
- A locally clean group with matching reports is `candidate-only`. It is not
  authorized: `v2WriterEnabled=false`, `safeForPayments=false`,
  `completeHistory=false`, `migrationEffective=false` in every result.
- EOSE from two clients/relays is only an initial observation barrier. Events
  may arrive late or be censored; a signed, account-bound, unanimous opt-in and
  a backwards-compatibility rollout protocol are still required before v2.
- The UI provides a collapsed diagnostic panel; no action can initiate a
  cutover or sign a financial v2 event.

## Future 3B-D requirements (not implemented)

1. Security-review the proposed Nostr namespace and action/schema version.
2. Define a migration request bound to exact owner, group head, members and
   event-set fingerprint, plus independently verified member-signed acceptances.
3. Explain upgrade requirements to each participant; a pubkey does not prove
   that all devices or older clients have upgraded.
4. Define an explicit immutable migration epoch and a signed final cutover,
   including rollback rules, incomplete/malicious relays and old-client bans.
5. Use separate read-only multi-device tests plus live relay tests with
   synthetic accounts before enabling v2 writers and financial actions.
6. Audit NIP-29 numerical conflicts and public-relay privacy before shipping.

## Verification

```sh
npm ci
npm test
npm run test:e2e
npm run build
npm audit
npm audit --omit=dev
git diff --check
```

Do not use real sats or production Nostr identities for migration testing.
