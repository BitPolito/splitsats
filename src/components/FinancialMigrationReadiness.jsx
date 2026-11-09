import { assessFinancialMigrationPreflight } from '../lib/financial-migration-preflight'
import { pendingOutbox } from '../lib/nostr'

// Read-only diagnostic; no migration or signing button is intentionally offered.
export default function FinancialMigrationReadiness({ group, account }) {
  let entries = null
  try { if (account) entries = pendingOutbox(account) } catch { /* fail closed */ }
  const result = assessFinancialMigrationPreflight(group, { outboxEntries: entries })
  return <details style={{ padding: '8px 16px', borderBottom: '1px solid var(--blue)',
    fontFamily: 'var(--mono)', fontSize: 10, lineHeight: 1.7, overflowWrap: 'anywhere' }}>
    <summary>3B-C · DIAGNOSTICA MIGRAZIONE FINANZIARIA NOSTR V2</summary>
    <p>Stato locale: <strong>{result.status}</strong>. Nessuna migrazione è stata eseguita.</p>
    <p>Writer v2 disabilitati. Le osservazioni di due client non dimostrano
      la completezza dei relay né la capacità di tutti i dispositivi.</p>
    <p>Blocchi e prerequisiti: {result.reasons.join(', ')}</p>
    <p>La migrazione richiederà un nuovo protocollo firmato da tutti i membri,
      verifica dei vecchi client e revisione separata della sicurezza Lightning.</p>
  </details>
}
