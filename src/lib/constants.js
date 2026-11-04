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
export const KIND_SETTLEMENT = 9001  // Debtor settlement CLAIM (pending until payee confirms)
export const KIND_CONFIRMATION = 9002  // Payee signed receipt confirmation
export const KIND_GROUP_REVISION = 9591 // Immutable owner-signed membership revision

export const APP_TAG = 'splitsats'    // Tag all our events for filtering