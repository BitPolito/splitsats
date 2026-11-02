// Settlement claims are not payments. Only an explicit signature by the recipient
// (a separate Nostr confirmation event) can make them affect group balances.
// A WebLN result is wallet-reported, NOT independently verified by this app.
export function isConfirmedSettlement(settlement, confirmations = []) {
  if (!settlement || typeof settlement._eventId !== 'string') return false
  return confirmations.some(confirmation =>
    confirmation && confirmation._pubkey === settlement.to &&
    confirmation.settlementEventId === settlement._eventId &&
    confirmation.from === settlement.from &&
    confirmation.to === settlement.to &&
    confirmation.amount === settlement.amount
  )
}

export function settlementStatus(settlement, confirmations = []) {
  if (isConfirmedSettlement(settlement, confirmations)) return 'confirmed'
  if (settlement?.method === 'webln' && settlement.walletReported === true) return 'wallet-reported'
  return 'pending'
}

export function approvedSettlements(settlements = [], confirmations = []) {
  return settlements.filter(settlement => isConfirmedSettlement(settlement, confirmations))
}
