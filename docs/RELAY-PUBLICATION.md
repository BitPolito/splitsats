# Phase 5 — Relay publication acknowledgements (NIP-20)

## What changes

- `publishEvent` now signs and verifies the event, then **waits for an explicit NIP-20 `OK` acceptance** from at least one relay before returning. `WebSocket.send` by itself is not success.
- The same signed event ID is resent if its WebSocket reconnects **while publication is still pending**. A pending event is sent upon connection if no relay was open initially.
- A definitive rejection from all configured relays fails the operation. Missing acknowledgement for 12 seconds yields an **uncertain outcome** error: the event might have been accepted without its acknowledgement arriving.
- The application updates its cached group, expense, settlement claim or recipient confirmation only after one acknowledgement. Group and expense modals show a pending state and surface errors.
- Subscriptions are resubmitted on reconnect. The first relay returning EOSE completes each subscription's initial load, rather than waiting forever for offline relays. Other relays continue sending events.

## Important limitations

- An `OK` is the relay's **acceptance report**, *not* proof of durable storage, multi-relay replication or a Lightning transfer. At least one accepting relay is required, not all.
- On timeout, **do not blindly resubmit**: the original event might already be on another relay. Reopen the relevant group and verify synchronization before trying again. In particular, never send a second Lightning payment just because Nostr publishing failed.
- Retry uses the *same signed event* only while the page is open and the publication is pending. There is **no durable signed-event outbox** or recovery from a browser reload; that is the next reliability feature to implement.
- Relay connection backoff may extend beyond the 12-second publication deadline in difficult network conditions.
- EOSE from the fastest relay is not a guarantee that the global history is complete. Historical data may continue arriving from slower relays; an explicit completeness indicator would need separate UI logic.
- WebSocket/mock unit tests do not replace tests against live Nostr relays, NIP-07 signers and two browsers.

## Manual smoke tests

1. With two real Nostr accounts, create a group. Confirm both browsers see it after reload.
2. Disable all network connections. Try to add an expense; it must not be silently marked saved. After the timeout, check for an uncertain-delivery error.
3. Connect only one live relay and try a new expense; verify the UI updates only after its NIP-20 `OK`.
4. Verify newly added events arrive on the second device and that a relayed duplicate is ignored.
5. Disconnect a relay while a publication is pending and reconnect before the deadline; verify only the original signed event ID is retried.
6. Confirm wallet operations are never treated as received money merely because a relay accepted a Nostr event.
