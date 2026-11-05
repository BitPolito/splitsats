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
export const KIND_GROUP_INVITATION = 9592 // Invitee-signed consent decision
export const KIND_EXPENSE_DECISION = 9593 // Participant-signed expense approval or dispute
export const KIND_EXPENSE_CANCELLATION = 9594 // Participant-signed disputed proposal cancellation

export const KIND_MEMBER_EXIT = 9595 // Voluntary member-signed leave request
export const KIND_HISTORICAL_ATTESTATION = 9596 // Historical snapshot signature; NEVER a payment authorization
export const KIND_HISTORICAL_RECONCILIATION = 9597 // Unanimous proposed net acknowledgment; NEVER a payment authorization
export const KIND_HISTORICAL_DISPOSITION_INTENT = 9598 // Non-effective signed review preference; no debt release

export const APP_TAG = 'splitsats'    // Tag all our events for filtering
