# SplitSats v1.0 — 3B-G: destination-specific financial group review

**Prerequisite:** phase 3B-F has been merged to `dev` and the repository is clean.

This phase formalizes an independently signed Nostr kind **9604** payload, bound to an
**exact source group, current signed revision, prior planning fingerprint, complete
participant roster and proposed target address**. The phase deliberately implements
**only** the protocol builders, strict parser, non-effective review summary and a
read-only UI preview. It does **not** wire a 9604 subscription or a signing button.
An actual future publication phase must first implement authenticated subscriptions,
account and outbox checks, independent relay audits and tests using two real signers.

## Where the new destination comes from

`buildFinancialDestinationDraft(group, {outboxEntries, ...})` first re-evaluates the
3B-F read-only source plan, requiring a `proposal-only` result. An unverified source,
missing 9603 signers, incompatible legacy activity, unconfirmed publication or
quarantined financial head cannot become a destination draft.

It deterministically derives:

- Target `d` tag: `splitsats-v2-<first 48 hex characters of planningFingerprint>`
- Target Nostr address: `30001:<existing group owner hex>:<derived d tag>`
- Proposal hash: SHA-256 of a canonical, domain-separated tuple containing source
  address, source signed revision, exact target address, planning fingerprint and
  full sorted signer roster. The hash is *not* a transaction ID, a new group event
  or a migration certificate.

A new 9603 preference ID yields a different planning fingerprint and therefore a
new proposed destination and hash. A later source revision cannot inherit the
older signed intent. Draft objects are locally constructed and identity-checked;
serialized or network-provided draft objects are not trusted as canonical plans.

## Proposed kind 9604 format (NOT published in this phase)

The content is exact JSON with keys:

```
{
  "version": 1,
  "action": "review-exact-independent-financial-group-v1",
  "choice": "support-target-review",
  "sourceGroupAddress": "30001:<owner>:<old-d>",
  "sourceRevisionEventId": "<signed-head-id>",
  "targetGroupAddress": "30001:<owner>:<new-d>",
  "planningFingerprint": "<sha256-hex>",
  "proposalHash": "<sha256-hex>"
}
```

The only other choice is `decline-target-review`. Tags include exactly one each
of `g`, `a`, `r`, `z`, `x`, `v`, `t` plus one `p` per member; parser rejects any
other/missing/duplicate tag, altered destination, wrong signer, stale revision,
unknown schema version or malformed content. **A Nostr signature must be
cryptographically verified by the relay ingress before calling the parser.**
The parser does not by itself verify Schnorr signatures.

The pure summary is conflict-aware, idempotent for an identical signed event ID
seen across relays, and requires every current member for a non-effective
`unanimous-target-review-only` label. A single decline, mismatched signed content,
multiple choices by the same member, or evidence limit exceedance never
produces unanimity. Matching EOSE of a selected set of relays cannot prove
complete history or global finality.

## Absolutely NOT enabled by this phase

- Publishing the proposed 9604 events or creating the target group
- Republishing any legacy event, converting old debts or clearing a balance
- Enabling 9600/9601/9602 writers, making Lightning payments or releasing an
  existing group from quarantine
- Treating 9603 preferences as destination-specific consent, or assuming every
  legacy client has been retired

The deterministic destination reveals source-owner linkage. Do not publish
real user group metadata or financial content to public relays as a migration
experiment. Prefer synthetic accounts and a relay-controlled test environment.

## Test before commit

```
npm ci
npm test
npm run test:e2e
npm run build
npm audit
npm audit --omit=dev
git diff --check
```

**Next phase (3B-H):** signed 9604 publication and reception behind an explicit
user action, exact-revision gating, durable outbox and per-relay audit, still
non-executable. It needs separate multi-client end-to-end testing. A later
versioned, independently reviewed protocol is required before any real cutover.
