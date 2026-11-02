// ─── Balance calculation ──────────────────────────────────────────────────────
// Given a list of expenses and settlements, compute simplified net debts.

export function calcNetBalances(expenses = [], settlements = [], members = []) {
  // net[pubkey] = how much they are owed (positive) or owe (negative)
  const net = {}
  members.forEach(m => { net[m] = 0 })

  expenses.forEach(exp => {
    // Only accepted, integer satoshi amounts can affect a balance.
    if (!exp || !Number.isSafeInteger(exp.amount) || exp.amount <= 0 || !members.includes(exp.paidBy)) return

    const requested = exp.splits?.length ? exp.splits : members
    // A malformed relay event must not create debts for non-members or charge someone twice.
    const involved = [...new Set(requested)].filter(member => members.includes(member))
    if (!involved.length) return

    // Distribute every satoshi: Math.round(amount / n) silently over/undercharges.
    const base = Math.floor(exp.amount / involved.length)
    const remainder = exp.amount % involved.length
    involved.forEach((member, index) => {
      const share = base + (index < remainder ? 1 : 0)
      if (member !== exp.paidBy) {
        net[exp.paidBy] += share
        net[member] -= share
      }
    })
  })

  // Apply only valid transfers between existing members.
  settlements.forEach(s => {
    if (!s || !Number.isSafeInteger(s.amount) || s.amount <= 0 || s.from === s.to) return
    if (!members.includes(s.from) || !members.includes(s.to)) return
    net[s.from] += s.amount
    net[s.to] -= s.amount
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
