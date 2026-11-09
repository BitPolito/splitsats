import { useEffect, useState } from 'react'
import { buildHistoricalDispositionDrafts } from '../lib/historical-disposition'
import { historicalDispositionIntentSummary, historicalDispositionIntentReady } from '../lib/historical-disposition-intents'
import { historicalReviewStatus, buildHistoricalReviewRecord } from '../lib/historical-review-record'

// A read-only choice preview. Never publishes events or alters operational state.
export default function HistoricalDispositionReview({ group, snapshot, checkpoint,
  rows, sourceAudit, decisionAudit, conflict = false, account,
  intentRows = [], intentAudit = null, intentConflict = false,
  onSign = null, auditOnly = false }) {
  const [mode, setMode] = useState('retain-historical-record')
  const [preview, setPreview] = useState(null)
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reviewRecord, setReviewRecord] = useState(null)
  useEffect(() => {
    let active = true
    setPreview(null)
    buildHistoricalDispositionDrafts({ group, snapshot, checkpoint,
      reconciliations: rows, sourceAudit, decisionAudit, conflict })
      .then(result => { if (active) setPreview(result) })
      .catch(() => { if (active) setPreview({ status: 'unavailable', reason: 'preview-error', drafts: [] }) })
    return () => { active = false }
  }, [group, snapshot, checkpoint, rows, sourceAudit, decisionAudit, conflict])

  // This status describes signed REVIEW, never legal or payment finality.
  const review = historicalReviewStatus({ group, drafts: preview?.drafts,
    checkpoint, intents: intentRows, sourceAudit, decisionAudit, intentAudit,
    conflict, intentConflict })
  useEffect(() => {
    let alive = true
    setReviewRecord(null)
    if (preview?.status === 'ready-for-review' && review.status === 'review-recorded') {
      void buildHistoricalReviewRecord({ group, snapshot, checkpoint,
        reconciliations: rows, sourceAudit, decisionAudit, intents: intentRows,
        intentAudit, conflict, intentConflict })
        .then(result => { if (alive) setReviewRecord(result) })
        .catch(() => { if (alive) setReviewRecord(null) })
    }
    return () => { alive = false }
  }, [group, snapshot, checkpoint, rows, sourceAudit, decisionAudit,
    conflict, intentRows, intentAudit, intentConflict, preview, review.status])
  // Never show an old fingerprint after a signature or revision changed, even
  // during the render before the async recheck has completed.
  const currentRecord = review.status === 'review-recorded' &&
    reviewRecord?.status === 'review-recorded' &&
    reviewRecord.record?.revisionEventId === group?._revisionId &&
    reviewRecord.record?.checkpointHash === checkpoint?.hash &&
    reviewRecord.record?.mode === review.selectedMode &&
    reviewRecord.record?.signedEvents?.length === review.required.length &&
    reviewRecord.record.signedEvents.every(([pk, id]) =>
      intentRows.some(row => row.member === pk && row.id === id)) &&
    historicalDispositionIntentReady(sourceAudit, decisionAudit, intentAudit)

  const chosen = preview?.drafts?.find(d => d.mode === mode)
  const summary = historicalDispositionIntentSummary(group, preview?.drafts, checkpoint, intentRows)
  const status = intentConflict ? 'conflict' : summary.status
  const ready = historicalDispositionIntentReady(sourceAudit, decisionAudit, intentAudit)
  const canSign = preview?.status === 'ready-for-review' && ready &&
    status === 'pending' && summary.pending.includes(account) &&
    typeof onSign === 'function' && !busy
  const select = next => { setMode(next); setConsent(false); setError('') }
  const sign = async () => {
    if (!canSign || !consent) return
    setBusy(true); setError('')
    try { await onSign(mode); setConsent(false) }
    catch (e) { setError(e.message || 'Errore firma preferenza') }
    finally { setBusy(false) }
  }
  return <section role="status" style={{ padding: '10px 0', fontFamily: 'var(--mono)',
    fontSize: 10, lineHeight: 1.7, overflowWrap: 'anywhere' }}>
    <strong>2E-F-B · TRATTAMENTO STORICO — REVISIONE FIRMATA NON ESECUTIVA</strong>
    <p>Stato preferenze: {status} · firme {summary.signed.length}/{summary.required.length} · relay: {intentAudit?.status || 'in attesa'}. Nessun effetto finanziario.</p>
    <div style={{ border: '1px solid var(--blue)', padding: 8, margin: '8px 0' }}>
      <strong>2E-F-C · ESITO DELLA REVISIONE NON VINCOLANTE</strong>
      <div>Stato: {review.status} · firme osservate {review.signed.length}/{review.required.length}</div>
      {review.status === 'pending' && <div>Revisione incompleta: mancano {review.pending.length} preferenze firmate.</div>}
      {review.status === 'disagreement' && <div role="alert">Disaccordo: nessuna decisione può essere eseguita.</div>}
      {review.status === 'conflict' && <div role="alert">Prove in conflitto: verifica manuale obbligatoria.</div>}
      {review.status === 'unsynchronized' && <div>Relay non sincronizzati: nessuna impronta di revisione valida.</div>}
      {review.status === 'unavailable' && <div>Storico o revisione non verificabili.</div>}
      {review.status === 'review-recorded' && <>
        <div>Preferenza unanime osservata: {review.selectedMode} (nessuna estinzione).</div>
        {currentRecord ? <div>Impronta locale delle firme osservate:
          {' '}<code style={{ overflowWrap: 'anywhere' }}>{reviewRecord.record.recordHash}</code></div>
          : <div>Verifica dell'impronta delle firme in corso…</div>}
      </>}
      <div>Questo stato può cambiare con nuove prove; non è un accordo legalmente
        esecutivo, un pagamento o un saldo trasferibile.</div>
    </div>
    {summary.reasons.length > 0 && <p role="alert">Verifica manuale: {summary.reasons.join(', ')}</p>}
    {status === 'disagreement' && <p role="alert">Le preferenze divergono: nessuna decisione automatica.</p>}
    {status === 'unanimous-review' && <p>Revisione unanime osservata, non vincolante e non esecutiva.</p>}
    {!preview ? <p>Verifica della riconciliazione…</p> : preview.status !== 'ready-for-review' ?
      <p>Nessuna proposta disponibile: {preview.reason}. Servono evidenze storiche e firme
        concordanti, senza conflitti, prima di valutare il trattamento dei debiti.</p> : <>
      <p>Il gruppo conserva un registro storico separato. Puoi confrontare le due
        ipotesi senza eseguire alcuna operazione finanziaria.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" aria-pressed={mode === 'retain-historical-record'}
          onClick={() => select('retain-historical-record')}>CONSERVA REGISTRO STORICO</button>
        <button type="button" aria-pressed={mode === 'propose-mutual-waiver'}
          onClick={() => select('propose-mutual-waiver')}>IPOTESI DI RINUNCIA RECIPROCA</button>
      </div>
      {chosen && <>
        <p>{mode === 'retain-historical-record'
          ? 'I saldi storici resterebbero separati: non entrano nei debiti pagabili del gruppo corrente.'
          : 'Simulazione di azzeramento: richiederebbe un consenso indipendente e valido di tutti gli interessati.'}</p>
        <div>Originale → ipotesi, in satoshi:</div>
        {chosen.historicalNet.map(([pk, original], index) =>
          <div key={pk}><code>{pk}</code>{pk === account ? ' (tu)' : ''}:
            {' '}{original > 0 ? '+' : ''}{original} →
            {' '}{chosen.proposedNet[index][1] > 0 ? '+' : ''}{chosen.proposedNet[index][1]} sat</div>)}
        <p>Impronta della bozza: <code>{chosen.draftHash}</code></p>
        {canSign && <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={consent}
              onChange={e => setConsent(e.target.checked)} />
            <span>Desidero registrare una preferenza firmata su questa bozza.
              Comprendo che sara pubblicata in chiaro sui relay Nostr, non estingue
              alcun debito e non autorizza pagamenti.</span>
          </label>
          <button type="button" disabled={!consent || busy} onClick={sign}>
            {busy ? 'FIRMA IN CORSO…' : 'REGISTRA PREFERENZA FIRMATA'}
          </button>
        </>}
        {error && <p role="alert">{error}</p>}
      </>}
    </>}
    <p style={{ color: 'var(--red)' }}>La firma registra soltanto una preferenza osservata.
      Non è una rinuncia giuridicamente efficace, non estingue o trasferisce debiti,
      non prova pagamenti Lightning e non abilita saldi pagabili.
      {auditOnly ? ' L’archivio resta isolato dal gruppo attivo.' : ''}</p>
  </section>
}
