# SplitSats phase 2E-A — read-only historical financial evidence

When old-head financial Nostr events are observed after a membership change,
SplitSats already fails closed. Phase 2E-A additionally retains a **bounded,
read-only evidence index** in the active relay-reconstructed group state.

Each entry contains the signed Nostr event ID, old revision ID, event kind,
signer pubkey and signed timestamp. It deliberately **does not parse amounts,
compute balances or release debts**. The signature is checked at the RelayPool
boundary. The evidence index independently checks author-scoped group tags,
old revision membership, unique tags, timestamps and supported financial kinds.
Malformed events continue to trigger a conservative lock, not an unlock.

Repeated events deduplicate by immutable event ID. The bounded index retains
up to 500 identifiers; overflow produces a prominent warning while retaining
the financial block. A cached copy is never proof: the group is reconstructed
from relay-signed events after reload. Relay EOSE is not completeness/finality.

Next milestone 2E-B requires a versioned per-revision financial ledger with
verified approvals, signed settlement confirmations, cross-revision carryover
and explicit multi-party reconciliation. **Do not** derive an amount from this
index or use it to make real Lightning payments.
