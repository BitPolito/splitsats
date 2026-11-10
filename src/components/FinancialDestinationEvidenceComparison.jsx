import { useState } from 'react'
import { verifyEvent } from 'nostr-tools'
import {
  buildFinancialDestinationEvidenceBundle, compareFinancialDestinationEvidenceBundles,
  MAX_DESTINATION_EVIDENCE_JSON,
} from '../lib/financial-destination-evidence'

// Read-only: import/export of PUBLIC signature-verified 9604 evidence. No wallet,
// group creation, Nostr publication or automatic agreement is reachable here.
export default function FinancialDestinationEvidenceComparison({ group, draft }) {
  const [imported, setImported] = useState('')
  const [result, setResult] = useState(null)
  const events = group._destinationSignedEvidence || []
  const relayStatus = group._destinationConsentAudit?.status || 'unknown'
  const local = buildFinancialDestinationEvidenceBundle(group, draft, events,
    relayStatus, verifyEvent)
  // When the local relay view changes, an old comparison must not appear fresh.
  const identity = JSON.stringify([draft?.proposalHash, relayStatus, events,
    group._destinationConsentConflict])
  const comparison = result?.identity === identity ? result.report : null
  const exported = local.status === 'exportable-observation'
    ? JSON.stringify(local.bundle) : ''
  const onCompare = () => {
    if (!exported || group._destinationConsentConflict) return
    let peer
    try {
      if (imported.length > MAX_DESTINATION_EVIDENCE_JSON) throw new Error('File troppo grande')
      peer = JSON.parse(imported)
    } catch {
      setResult({ identity, report: { status: 'invalid-json',
        reasons: ['JSON della seconda istanza non valido o troppo grande'] } })
      return
    }
    setResult({ identity, report: compareFinancialDestinationEvidenceBundles(
      group, draft, local.bundle, peer, verifyEvent) })
  }
  return <section aria-label="Confronto eventi firmati destinazione 9604"
    style={{ borderTop: '1px solid var(--blue)', marginTop: 8, paddingTop: 8 }}>
    <strong>3B-I · VERIFICA INDIPENDENTE FIRME PUBBLICHE 9604</strong>
    <p>Eventi firmati verificati sul dispositivo: {local.verifiedCount ?? 0}. Stato:
      <strong> {local.status}</strong>. Il recupero dopo refresh usa gli eventi
      nuovamente ricevuti dai relay o la outbox originale.</p>
    {local.reasons?.length > 0 && <p role="alert">Evidenze: {local.reasons.join(', ')}</p>}
    <p>Il JSON contiene firme, chiavi pubbliche e destinazione Nostr. Condividilo
      solo con chi deve confrontare le prove; non contiene credenziali o dati del wallet.</p>
    {exported && <>
      <label htmlFor="destination-signed-export">Prove firmate di questo browser (copia il JSON)</label>
      <textarea id="destination-signed-export" aria-label="JSON pubblico firme Nostr verificato"
        readOnly value={exported} rows={5} style={{ width: '100%', fontFamily: 'monospace' }} />
    </>}
    <label htmlFor="destination-signed-import">Incolla il JSON esportato da un altro browser</label>
    <textarea id="destination-signed-import" aria-label="JSON firmato da confrontare"
      rows={4} maxLength={MAX_DESTINATION_EVIDENCE_JSON + 1}
      value={imported} onChange={e => { setImported(e.target.value); setResult(null) }}
      placeholder="{…}" style={{ width: '100%', fontFamily: 'monospace' }} />
    <button type="button" disabled={!exported || !imported.trim() ||
      !!group._destinationConsentConflict} onClick={onCompare}>
      VERIFICA FIRME E CONFRONTA
    </button>
    {comparison && <p role="status">Confronto: <strong>{comparison.status}</strong>.
      {comparison.reasons?.join(', ')}</p>}
    <p>Anche due raccolte identiche non dimostrano che tutti i relay o vecchi
      dispositivi abbiano visto ogni evento. Nessuna operazione finanziaria è autorizzata.</p>
  </section>
}
