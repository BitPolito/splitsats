# SplitSats PR #23 — prior revision financial history synchronization gate

Phase 2D-B signed member exits and Phase 2D-A additions can produce a new,
owner-signed revision before older signed financial records have been replayed.
The local Nostr event stream may deliver an exit proof earlier than historical
expense/settlement records. Merely observing the exit proof must **never**
unlock the group's ledger.

This hotfix retains `_financialReviewRequired=true` after a membership change.
It subscribes to previous-head financial events and requires the first `EOSE`
on that stream before clearing the review lock. Signed exit proofs, when
needed, must also have been received and independently verified. Incoming
old-head financial activity freezes the group immediately, even after EOSE.
Only when the history gate succeeds may fresh signed invitation consents be
used to activate the financial ledger.

**Limitations:** Nostr EOSE marks a relay's initial snapshot, not cryptographic
proof of complete history. Malicious, stale, or selectively omitting relays can
hide financial events; this is still not safe to use for production Lightning
payments. Do not treat exit as debt forgiveness. Real-funds deployment still
requires a versioned cross-revision ledger and independent multi-device audit.
