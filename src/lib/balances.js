// ─── Balance calculation ──────────────────────────────────────────────────────
// Given a list of expenses and settlements, compute simplified net debts.

export function calcNetBalances(expenses = [], settlements = [], members = []) {
  // net[pubkey] = how much they are owed (positive) or owe (negative)
  const net = {}
  members.forEach(m => { net[m] = 0 })

  expenses.forEach(exp => {
    const involved = exp.splits?.length ? exp.splits : members
    const perPerson = Math.round(exp.amount / involved.length)
    involved.forEach(member => {
      if (member !== exp.paidBy) {
        net[exp.paidBy]  = (net[exp.paidBy]  || 0) + perPerson
        net[member]      = (net[member]       || 0) - perPerson
      }
    })
  })

  // Apply settlements
  settlements.forEach(s => {
    net[s.from] = (net[s.from] || 0) + s.amount
    net[s.to]   = (net[s.to]   || 0) - s.amount
  })

  return net
}

// Simplify debts using greedy algorithm — minimizes number of transactions
export function simplifyDebts(expenses = [], settlements = [], members = []) {
  const net = calcNetBalances(expenses, settlements, members)

  const creditors = [] // owed money
  const debtors   = [] // owe money

  Object.entries(net).forEach(([pubkey, amount]) => {
    if (amount > 0)  creditors.push({ pubkey, amount })
    else if (amount < 0) debtors.push({ pubkey, amount: -amount })
  })

  creditors.sort((a, b) => b.amount - a.amount)
  debtors.sort((a, b)   => b.amount - a.amount)

  const transactions = []
  let i = 0, j = 0

  while (i < debtors.length && j < creditors.length) {
    const debtor   = debtors[i]
    const creditor = creditors[j]
    const amount   = Math.min(debtor.amount, creditor.amount)

    if (amount > 0) {
      transactions.push({ from: debtor.pubkey, to: creditor.pubkey, amount })
    }

    debtor.amount   -= amount
    creditor.amount -= amount

    if (debtor.amount   < 1) i++
    if (creditor.amount < 1) j++
  }

  return transactions
}

// Human-readable summary for a single member
export function memberSummary(pubkey, expenses = [], settlements = [], members = []) {
  const net = calcNetBalances(expenses, settlements, members)
  const balance = net[pubkey] || 0
  return {
    balance,
    isCreditor: balance > 0,
    isDebtor:   balance < 0,
    isSettled:  balance === 0,
  }
}
