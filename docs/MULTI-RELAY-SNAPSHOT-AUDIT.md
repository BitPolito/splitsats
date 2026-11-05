# SplitSats Phase 2E-D-A — per-relay observed snapshot comparison

## Why

Previously `RelayPool` deduplicated signed Nostr event IDs across relays before
application callbacks and called application `onEose` after the first relay
replied. This deliberately favors responsive UI, but does **not** permit a
client to distinguish different source snapshots. Neither `EOSE` nor an `OK`
publication acknowledgment is proof of global completeness, finality, or a
Lightning payment.

## Mechanism

The transport now exposes **optional**, passive subscription hooks:

- `onRelayEvent(event, relayUrl)` after signature verification and **before**
  cross-relay application deduplication;
- `onRelayEose(relayUrl)` for each source's first and later `EOSE` frames;
- `onRelayReset(relayUrl, 'disconnected' | 'connected')` to invalidate a
  disconnected relay's prior snapshot and start a fresh connection epoch.

These hooks do not change the legacy `onEvent` once-per-event behavior or the
existing `onEose` first-response behavior. An exception inside an optional
hook is isolated from financial/event processing. A relay sends only its own
untrusted replies; signature verification still runs before the audit.

`RelaySnapshotAudit` tracks the exact immutable event IDs and signed envelope
fingerprints *per configured source*. It reports:

- `pending`: not all configured relays have returned an initial `EOSE`;
- `matching-observed`: all configured relays ended their current epoch with
  identical observed event sets; **this is not completeness**;
- `divergent`: two completed relay epochs disagree about IDs or signed
  envelopes, even if other relays have not replied;
- `changed-after-eose`: new signed activity was observed after a relay's
  initial `EOSE` (the initial snapshot is no longer stable);
- `at-limit` / `overflow`: the bounded query may be truncated;
- `conflict`: malformed or internally contradictory signed-envelope input.

For multi-revision groups this report is persisted in ephemeral, verified
store group state as `_priorRelayAudit` and displayed in Group Detail. The
separate ex-member archive shows the same diagnostic after the signed exit
proof was verified; it never adds the former user back into active groups.

## Important limits

1. All public relay operators might collude, lag, filter, censor, or return
   the **same incomplete subset**. No number of matching relays is proof of
   completeness. `safeForPayments` and `completeHistory` are always `false`.
2. Source reports are per currently connected socket epoch. Disconnect and
   reconnect invalidate the previous initial snapshot. Sources not returning
   `EOSE` keep the report pending.
3. The prior-revision Nostr subscription itself requests `limit: 500`; when
   a source returns exactly 500 events, audit returns `at-limit` even before a
   further event is observed. Overflow remains conservative across reconnects.
4. This is an **observation diagnostic**, not a consensus quorum: no new
   balance, debt forgiveness, publication retry, membership change or
   Lightning financial authorization is based on the report.
5. Nostr event delivery metadata (`relayUrl`) is passed from the WebSocket
   transport, not read from untrusted content of the event.

## Test scope

The pure module includes cases for matching/divergent snapshots, duplicates,
identity conflicts, signature-boundary expectations, EOSE, reconnects,
late events, overflow and query saturation. Transport tests check that the
application still deduplicates its callback while receiving separate
signature-validated per-relay notifications.

Run the full Node/Playwright/Vite/audit workflow in the actual Git repository
before merging. Do not use real Lightning funds on revised financial history.
