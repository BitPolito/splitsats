// Read-only, bounded diagnostics for source-specific Nostr event observations.
// Never use these results to authorize debt settlement or membership updates.
export default function RelaySnapshotDiagnostics({ audit }) {
  if (!audit) return null

  return <div style={{ overflowWrap: 'anywhere' }}>
    <div>Snapshot osservati: {audit.status} · EOSE {audit.completedRelays}/{audit.configuredRelays}</div>
    <div>Unione degli ID osservati dai relay con EOSE: {audit.observedUnionEventCount ?? '—'}</div>
    {(audit.relays || []).map(row => <div key={row.relay} style={{ marginTop: 6 }}>
      <div>{row.relay} · {row.phase} · {row.eventCount} ID firmati
        {row.notObservedCount !== null && row.notObservedCount !== undefined &&
          <> · non osservati: {row.notObservedCount}</>}
      </div>
      {(row.notObservedSample || []).map(id =>
        <div key={id}>Non osservato qui: <code style={{ overflowWrap: 'anywhere' }}>{id}</code></div>)}
      {row.notObservedCount > (row.notObservedSample || []).length &&
        <div>Altri {row.notObservedCount - row.notObservedSample.length} ID non mostrati.</div>}
    </div>)}
    {(audit.differingEnvelopeCount || 0) > 0 && <>
      <div role="alert">Eventi con lo stesso ID ma envelope differenti: {audit.differingEnvelopeCount}</div>
      {(audit.differingEnvelopeSample || []).map(id =>
        <div key={id}>ID in conflitto: <code style={{ overflowWrap: 'anywhere' }}>{id}</code></div>)}
      {audit.differingEnvelopeCount > (audit.differingEnvelopeSample || []).length &&
        <div>Altri ID in conflitto non mostrati.</div>}
    </>}
    <div>Queste differenze riguardano solo gli eventi ricevuti. Anche un accordo fra relay non prova la completezza dello storico e non autorizza pagamenti.</div>
  </div>
}
