import { useEffect, useState } from 'react'
import { pendingOutbox, subscribeOutbox } from '../lib/nostr'
import { buildFinancialNamespacePlan } from '../lib/financial-namespace-plan'

// Read-only planning evidence. Never put this fingerprint into publication,
// payment routing, balance computation or a "migration complete" indicator.
export default function FinancialNamespacePlanningPreview({ group, account }) {
  const [result, setResult] = useState(null)
  const [outboxRevision, setOutboxRevision] = useState(0)
  // Pending publications can change without modifying the group object.
  useEffect(() => subscribeOutbox(() => setOutboxRevision(n => n + 1)), [])
  // This key prevents a previous async fingerprint from appearing as the
  // current revision's plan while the new calculation is in progress.
  const key = JSON.stringify([
    group?.pubkey, group?.id, group?._revisionId, group?._revisionStatus,
    group?.members, group?._migrationReviewRows, group?._migrationReviewAudit?.status,
    group?._migrationReviewConflict, group?._financialMigrationQuarantine,
    group?._financialReviewRequired, group?._expenseReviewRequired,
    group?._financialHistoryChecked, group?._priorHistoryChecked,
    group?.expenses?.length, group?.proposedExpenses?.length,
    group?.settlements?.length, group?.confirmations?.length,
    group?._expenseDecisions?.length, group?._cancellationDecisions?.length,
    account, outboxRevision,
  ])
  useEffect(() => {
    let active = true
    let entries = null
    try { if (account) entries = pendingOutbox(account) } catch { /* deny */ }
    void buildFinancialNamespacePlan(group, { outboxEntries: entries })
      .then(plan => { if (active) setResult({ key, plan }) })
      .catch(() => { if (active) setResult({ key, plan: null }) })
    return () => { active = false }
  }, [group, account, key])
  const plan = result?.key === key ? result.plan : null
  return <section aria-label="Anteprima namespace finanziario v2"
    style={{ borderTop: '1px solid var(--blue)', paddingTop: 8 }}>
    <strong>3B-F · NUOVO NAMESPACE — SOLO ANTEPRIMA LOCALE</strong>
    <p>Stato: {plan?.status || 'calcolo non disponibile'}.
      Un nuovo gruppo indipendente richiede nuovi consensi espliciti, non le firme 9603 precedenti.</p>
    {plan?.planningFingerprint && <p>
      Impronta diagnostica SHA-256: <code>{plan.planningFingerprint.slice(0, 20)}…</code>
      <span> (non è un indirizzo Nostr né una prova di migrazione)</span>
    </p>}
    {plan?.reasons?.length > 0 && <p>Limiti: {plan.reasons.join(', ')}</p>}
    <p>Writer 9600–9602: <strong>DISABILITATI</strong>.
      Nessun debito importato, pagamento abilitato o vecchio gruppo ritirato.</p>
  </section>
}
