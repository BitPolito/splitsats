import { useState } from 'react'
import { historicalReconciliationSummary } from '../lib/historical-reconciliation'

// A separate opt-in from the historical "observed" snapshot attestation.
// Every user is shown exactly the net vector included in the signed hash.
export default function HistoricalReconciliationPanel({ group, checkpoint, rows = [], conflict = false,
  account, onSign, busy = false, error = '', auditOnly = false }) {
  const [consent, setConsent] = useState(false)
  const summary = historicalReconciliationSummary(group, checkpoint, rows)
  const status = conflict ? 'conflict' : summary.status
  const canSign = !!checkpoint && group?._reconciliationDecisionsChecked === true &&
    status === 'pending' && summary.pending.includes(account) &&
    typeof onSign === 'function' && !busy
  return <section role="status" style={{ padding: '10px 0', lineHeight: 1.7 }}>
    <strong>RICONCILIAZIONE STORICA — PROPOSTA DA FIRMARE</strong>
    {!checkpoint ? <p>Non disponibile: servono attestazioni unanimi dello snapshot,
      confronto relay concordante, sincronizzazione delle firme e ricostruzione non in conflitto.</p> : <>
      <p>Hash proposta: <code style={{ overflowWrap: 'anywhere' }}>{checkpoint.hash}</code></p>
      <p>Questi importi sono una proposta di saldo netto storico, non un ordine di pagamento:</p>
      <div style={{ overflowWrap: 'anywhere' }}>
        {checkpoint.proposedNet.map(([pk, value]) =>
          <div key={pk}><code style={{ overflowWrap: 'anywhere' }}>{pk}</code> · {value > 0 ? '+' : ''}{value} sat
            {pk === account ? ' (tu)' : ''}</div>)}
      </div>
      <p>Stato: {status} · firme {summary.signed.length}/{summary.required.length}.
        {status === 'agreed' ? ' Tutti hanno riconosciuto la stessa proposta.' : ''}</p>
      {status === 'conflict' && <p role="alert">Checkpoint in conflitto: richiede verifica manuale.</p>}
      {canSign && <>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
          <span>Ho verificato gli importi proposti e voglio firmare il riconoscimento
            di questa specifica ricostruzione storica osservata.</span>
        </label>
        <button disabled={!consent || busy} onClick={onSign}
          style={{ padding: 9, marginTop: 8, border: '2px solid var(--blue)',
            background: 'var(--surface)', color: 'var(--blue)', cursor: !consent ? 'not-allowed' : 'pointer' }}>
          {busy ? 'FIRMA IN CORSO…' : 'FIRMA IL CHECKPOINT'}
        </button>
      </>}
    </>}
    {error && <p role="alert">{error}</p>}
    <p>Attenzione: anche un checkpoint unanime non garantisce la completezza dei relay,
      non certifica incassi Lightning, non estingue debiti e non sblocca pagamenti.
      {auditOnly ? ' L’archivio dell’ex membro resta in sola lettura.' : ''}</p>
  </section>
}
