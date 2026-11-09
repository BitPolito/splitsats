import { assessFinancialMigrationPreflight } from '../lib/financial-migration-preflight'
import { pendingOutbox } from '../lib/nostr'
import { canReviewFinancialMigration, financialMigrationReviewSummary } from '../lib/financial-migration-intents'
import { assessFinancialClientCutoverBarrier } from '../lib/financial-client-compatibility'
import FinancialNamespacePlanningPreview from './FinancialNamespacePlanningPreview'
import { useState } from 'react'

// Signed non-effective review: publication is visible on public Nostr relays.
export default function FinancialMigrationReadiness({ group, account, onSignReview }) {
  const [choice, setChoice] = useState('support-review')
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  let entries = null
  try { if (account) entries = pendingOutbox(account) } catch { /* fail closed */ }
  const result = assessFinancialMigrationPreflight(group, { outboxEntries: entries })
  const summary = financialMigrationReviewSummary(group, group._migrationReviewRows || [],
    group._migrationReviewAudit, group._migrationReviewConflict)
  const compatibility = assessFinancialClientCutoverBarrier(group, { outboxEntries: entries })
  const eligible = !!account && canReviewFinancialMigration(group, entries) &&
    group._migrationReviewAudit?.status === 'matching-observed' &&
    !group._migrationReviewConflict && summary.status === 'pending' &&
    summary.pending.includes(account) && typeof onSignReview === 'function' && !busy
  const sign = async () => {
    if (!eligible || !consent) return
    setBusy(true); setError('')
    try { await onSignReview(choice); setConsent(false) }
    catch (e) { setError(e?.message || 'Firma non riuscita') }
    finally { setBusy(false) }
  }
  return <details style={{ padding: '8px 16px', borderBottom: '1px solid var(--blue)',
    fontFamily: 'var(--mono)', fontSize: 10, lineHeight: 1.7, overflowWrap: 'anywhere' }}>
    <summary>3B-C · DIAGNOSTICA MIGRAZIONE FINANZIARIA NOSTR V2</summary>
    <p>Stato locale: <strong>{result.status}</strong>. Nessuna migrazione è stata eseguita.</p>
    <p>Writer v2 disabilitati. Le osservazioni di due client non dimostrano
      la completezza dei relay né la capacità di tutti i dispositivi.</p>
    <p>Blocchi e prerequisiti: {result.reasons.join(', ')}</p>
    <p>3B-E · Compatibilità client legacy: <strong>{compatibility.status}</strong>.
      I vecchi client leggono 9000–9002, ma non vedono 9600–9602.
      Un doppio writer può duplicare un'operazione o creare saldi divergenti.</p>
    <p>Attivazione v2: <strong>DISABILITATA</strong>. Nemmeno una revisione firmata
      unanimemente dimostra che tutti i dispositivi siano aggiornati.</p>
    <p>Limiti ancora irrisolti: {compatibility.reasons.filter(reason =>
      ['old-client-retirement-not-verifiable', 'in-place-legacy-v2-cutover-unsafe',
        'signed-review-is-not-migration-authorization'].includes(reason)).join(', ')}</p>
    <p>3B-D · Preferenze firmate: <strong>{summary.status}</strong> ·
      {summary.signed.length}/{summary.required.length} firme ·
      relay {group._migrationReviewAudit?.status || 'pending'}.</p>
    {summary.reasons.length > 0 && <p role="alert">Evidenze: {summary.reasons.join(', ')}</p>}
    {summary.status === 'unanimous-review-observed' &&
      <p>Unanimità osservata: solo revisione non vincolante. Nessuna migrazione attivata.</p>}
    {summary.status === 'declined' && <p>Un membro ha rifiutato la proposta di revisione.</p>}
    {eligible && <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" aria-pressed={choice === 'support-review'}
          onClick={() => { setChoice('support-review'); setConsent(false) }}>SUPPORTA REVISIONE</button>
        <button type="button" aria-pressed={choice === 'decline-review'}
          onClick={() => { setChoice('decline-review'); setConsent(false) }}>RIFIUTA REVISIONE</button>
      </div>
      <label style={{ display: 'flex', gap: 7, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
        <span>Confermo di voler pubblicare questa preferenza in chiaro sui relay Nostr.
          La firma non estingue debiti, non aggiorna client e non attiva pagamenti.</span>
      </label>
      <button type="button" disabled={!consent || busy} onClick={sign}>
        {busy ? 'FIRMA IN CORSO…' : 'PUBBLICA PREFERENZA FIRMATA'}
      </button>
    </>}
    {error && <p role="alert">{error}</p>}
    <FinancialNamespacePlanningPreview group={group} account={account} />
    <p>La migrazione richiederà un nuovo protocollo firmato da tutti i membri,
      verifica dei vecchi client e revisione separata della sicurezza Lightning.</p>
  </details>
}
