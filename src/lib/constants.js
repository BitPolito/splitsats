export const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://relay.snort.social',
  'wss://relay.alby.com',
  'wss://nostr.mom',
]

// Custom event kinds for SplitSats
export const KIND_METADATA   = 0      // NIP-01 user profile
export const KIND_GROUP      = 30001  // Addressable event: group definition
export const KIND_EXPENSE    = 9000   // Expense event
export const KIND_SETTLEMENT = 9001  // Settlement / payment record

export const APP_TAG = 'splitsats'    // Tag all our events for filtering