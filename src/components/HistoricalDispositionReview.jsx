import { useEffect, useState } from 'react'
import { buildHistoricalDispositionDrafts } from '../lib/historical-disposition'

// A read-only choice preview. Never publishes events or alters operational state.
export default function HistoricalDispositionReview({ group, snapshot, checkpoint,
  rows, sourceAudit, decisionAudit, conflict = false, account }) {
  const [mode, setMode] = useState('retain-historical-record')
  const [preview, setPreview] = useState(null)
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
  return <section role="status" style={{ padding: '10px 0', fontFamily: 'var(--mono)',
    fontSize: 10, lineHeight: 1.7, overflowWrap: 'anywhere' }}>
    <strong>2E-F-A · TRATTAMENTO DELLO STORICO — SOLO ANTEPRIMA</strong>
    {!preview ? <p>Verifica della riconciliazione…</p> : preview.status !== 'ready-for-review' ?
      <p>Nessuna proposta disponibile: {preview.reason}. Servono evidenze storiche e firme
        concordanti, senza conflitti, prima di valutare il trattamento dei debiti.</p> : <>
      <p>Il gruppo conserva un registro storico separato. Puoi confrontare le due
        ipotesi senza eseguire alcuna operazione finanziaria.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" aria-pressed={mode === 'retain-historical-record'}
          onClick={() => setMode('retain-historical-record')}>CONSERVA REGISTRO STORICO</button>
        <button type="button" aria-pressed={mode === 'propose-mutual-waiver'}
          onClick={() => setMode('propose-mutual-waiver')}>IPOTESI DI RINUNCIA RECIPROCA</button>
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
      </>}
    </>}
    <p style={{ color: 'var(--red)' }}>Nessuna firma o rinuncia viene registrata da questa schermata.
      Nessun saldo viene trasferito, azzerato o reso pagabile. È indispensabile
      un successivo protocollo firmato, verificato e condiviso dagli interessati.</p>
  </section>
}
