import { useEffect, useState } from 'react'
import { pendingOutbox, subscribeOutbox } from '../lib/nostr'
import { buildFinancialNamespacePlan } from '../lib/financial-namespace-plan'
import { buildFinancialDestinationDraft } from '../lib/financial-destination-consent'
import { financialDestinationConsentSummary } from '../lib/financial-destination-consent'
import { canSignFinancialDestinationConsent } from '../lib/financial-destination-live'

// Read-only planning evidence. Never put this fingerprint into publication,
// payment routing, balance computation or a "migration complete" indicator.
export default function FinancialNamespacePlanningPreview({ group, account, onSignDestinationConsent }) {
  const [result, setResult] = useState(null)
  const [outboxRevision, setOutboxRevision] = useState(0)
  const [destinationChoice, setDestinationChoice] = useState('support-target-review')
  const [destinationConsentKey, setDestinationConsentKey] = useState(null)
  const [destinationBusy, setDestinationBusy] = useState(false)
  const [destinationError, setDestinationError] = useState('')
  // Pending publications can change without modifying the group object.
  useEffect(() => subscribeOutbox(() => setOutboxRevision(n => n + 1)), [])
  // This key prevents a previous async fingerprint from appearing as the
  // current revision's plan while the new calculation is in progress.
  const key = JSON.stringify([
    group?.pubkey, group?.id, group?._revisionId, group?._revisionStatus,
    group?.members, group?._migrationReviewRows, group?._migrationReviewAudit?.status,
    group?._migrationReviewConflict, group?._financialMigrationQuarantine,
    group?._destinationConsentRows, group?._destinationConsentAudit?.status,
    group?._destinationConsentConflict, group?._destinationConsentDraftHash,
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
    void Promise.all([
      buildFinancialNamespacePlan(group, { outboxEntries: entries }),
      buildFinancialDestinationDraft(group, { outboxEntries: entries }),
    ]).then(([plan, destination]) => {
      if (active) setResult({ key, plan, destination })
    }).catch(() => { if (active) setResult({ key, plan: null, destination: null }) })
    return () => { active = false }
  }, [group, account, key])
  const plan = result?.key === key ? result.plan : null
  const destination = result?.key === key ? result.destination : null
  const consentKey = `${account || ''}:${group?._revisionId || ''}:${destination?.proposalHash || ''}`
  const destinationConsent = destination?.status === 'specific-target-review-only' &&
    destinationConsentKey === consentKey
  let outbox = null
  try { if (account) outbox = pendingOutbox(account) } catch { /* deny */ }
  const destinationSummary = destination?.status === 'specific-target-review-only'
    ? financialDestinationConsentSummary(group, destination,
      group._destinationConsentRows || [], group._destinationConsentAudit,
      group._destinationConsentConflict) : null
  const eligible = !!account && !!destination &&
    canSignFinancialDestinationConsent(group, destination, account, outbox) &&
    typeof onSignDestinationConsent === 'function' && !destinationBusy
  const publishReview = async () => {
    if (!eligible || !destinationConsent) return
    setDestinationBusy(true); setDestinationError('')
    try { await onSignDestinationConsent(destinationChoice); setDestinationConsentKey(null) }
    catch (e) { setDestinationError(e?.message || 'Firma destinazione non riuscita') }
    finally { setDestinationBusy(false) }
  }
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
    {destination?.status === 'specific-target-review-only' && <section
      aria-label="Proposta di destinazione finanziaria non attiva"
      style={{ borderTop: '1px solid var(--blue)', marginTop: 8, paddingTop: 8 }}>
      <strong>3B-G · DESTINAZIONE ESATTA — SOLA PROPOSTA</strong>
      <p>Gruppo futuro ipotizzato: <code>{destination.targetGroupAddress}</code></p>
      <p>Impronta proposta: <code>{destination.proposalHash.slice(0, 20)}…</code>.
        Nessun nuovo gruppo è stato creato da questa proposta,
        nessun saldo trasferito o pagabile.</p>
      <p>3B-H · Firme sulla destinazione: <strong>{destinationSummary?.status || 'pending'}</strong>
        {' · '}{destinationSummary?.signedMembers?.length || 0}/{destinationSummary?.requiredMembers?.length || 0}
        {' · '}relay {group._destinationConsentAudit?.status || 'pending'}.</p>
      {destinationSummary?.status === 'unanimous-target-review-only' && <p>
        Preferenze unanimi osservate: nessun nuovo gruppo o pagamento autorizzato.</p>}
      {destinationSummary?.reasons?.length > 0 && <p>
        Verifiche: {destinationSummary.reasons.join(', ')}</p>}
      {eligible && <>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" aria-pressed={destinationChoice === 'support-target-review'}
            onClick={() => { setDestinationChoice('support-target-review'); setDestinationConsentKey(null) }}>
            SUPPORTA DESTINAZIONE</button>
          <button type="button" aria-pressed={destinationChoice === 'decline-target-review'}
            onClick={() => { setDestinationChoice('decline-target-review'); setDestinationConsentKey(null) }}>
            RIFIUTA DESTINAZIONE</button>
        </div>
        <label style={{ display: 'flex', gap: 7, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={destinationConsent}
            onChange={e => setDestinationConsentKey(e.target.checked ? consentKey : null)} />
          <span>Confermo la pubblicazione in chiaro su Nostr della mia preferenza
            per questa ESATTA destinazione. Non crea gruppi, non trasferisce
            saldi, non abilita pagamenti e non ritira i client precedenti.</span>
        </label>
        <button type="button" disabled={!destinationConsent || destinationBusy} onClick={publishReview}>
          {destinationBusy ? 'FIRMA IN CORSO…' : 'PUBBLICA FIRMA DESTINAZIONE 9604'}
        </button>
      </>}
      {destinationError && <p role="alert">{destinationError}</p>}
    </section>}
    <p>Writer 9600–9602: <strong>DISABILITATI</strong>.
      Nessun debito importato, pagamento abilitato o vecchio gruppo ritirato.</p>
  </section>
}
