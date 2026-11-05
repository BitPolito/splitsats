import { useEffect, useState } from 'react'
import { buildHistoricalDispositionDrafts } from '../lib/historical-disposition'
import { historicalDispositionIntentSummary, historicalDispositionIntentReady } from '../lib/historical-disposition-intents'

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
  useEffect(() => {
    let active = true
    setPreview(null)
    buildHistoricalDispositionDrafts({ group, snapshot, checkpoint,
      reconciliations: rows, sourceAudit, decisionAudit, conflict })
      .then(result => { if (active) setPreview(result) })
      .catch(() => { if (active) setPreview({ status: 'unavailable', reason: 'preview-error', drafts: [] }) })
    return () => { active = false }
  }, [group, snapshot, checkpoint, rows, sourceAudit, decisionAudit, conflict])

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
