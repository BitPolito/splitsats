import { useEffect, useRef, useState } from 'react'
import RelaySnapshotDiagnostics from '../components/RelaySnapshotDiagnostics'
import HistoricalReconciliationPanel from '../components/HistoricalReconciliationPanel'
import {
  subscribeFormerMemberExitHints, subscribeFormerMemberGroupDefinition,
  subscribeGroupRevisions, subscribeMemberExitRequests, subscribePriorRevisionActivity,
  subscribeHistoricalAttestations, subscribeHistoricalReconciliations, pendingOutbox, publishEvent,
} from '../lib/nostr'
import { verifyGroupRevisionHistory } from '../lib/group-revision-log'
import { isNewerGroupDefinition } from '../lib/event-validation'
import { parseMemberExitRequestEvent, verifyMemberExitProofs } from '../lib/member-exits'
import { formerMemberAuditEligibility } from '../lib/former-member-audit'
import { appendHistoricalReplayEvent, replayHistoricalFinancialEvents } from '../lib/historical-financial-replay'
import { priorFinancialEvidence, appendPriorEvidence } from '../lib/prior-financial-evidence'
import {
  buildHistoricalAttestationSnapshot, historicalAttestationTags,
  historicalAttestationSummary, parseHistoricalAttestationEvent,
} from '../lib/historical-attestations'
import {
  buildHistoricalReconciliationCheckpoint, historicalReconciliationTags,
  historicalReconciliationSummary, parseHistoricalReconciliationEvent,
  MAX_HISTORICAL_RECONCILIATIONS,
} from '../lib/historical-reconciliation'
import { KIND_HISTORICAL_ATTESTATION, KIND_HISTORICAL_RECONCILIATION, KIND_GROUP_INVITATION } from '../lib/constants'

// This view deliberately keeps archival groups OUT of Zustand's active `groups`.
// No active-group actions, debt transfer or Lightning payment can originate here.
const code = { fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.8, overflowWrap: 'anywhere' }
const btn = { padding: '9px 12px', border: '2px solid var(--blue)', color: 'var(--blue)',
  background: 'var(--surface)', cursor: 'pointer', fontFamily: 'var(--pixel)', fontSize: 7 }

export default function FormerMemberAuditView({ pubkey }) {
  const [hints, setHints] = useState([])
  const [chosen, setChosen] = useState(null)
  const [status, setStatus] = useState('Ricerca delle richieste di uscita firmate…')
  const [report, setReport] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reconBusy, setReconBusy] = useState(false)
  const [reconError, setReconError] = useState('')
  const reconSigning = useRef(false)
  const active = useRef(null)

  useEffect(() => {
    setHints([]); setChosen(null); setReport(null); setError('')
    if (!pubkey) return
    return subscribeFormerMemberExitHints(pubkey, hint => {
      setHints(old => old.some(x => x.id === hint.id) ? old : [...old, hint])
    })
  }, [pubkey])

  useEffect(() => {
    if (!chosen || !pubkey) { active.current = null; return }
    let closed = false
    let epoch = 0
    let inner = []
    let newest = null
    const runtime = { account: pubkey, group: null, events: [], attestations: [],
      snapshot: null, overflow: false, financial: false, eligible: false,
      priorEvidenceOverflow: false, evidence: [], historyChecked: false, version: 0,
      relayAudit: null, reconciliationRows: [], reconciliationConflict: false,
      reconciliationCheckpoint: null, reconciliationVersion: 0, reconcile: null }
    active.current = runtime
    setReport(null); setError(''); setStatus('Recupero definizione del gruppo firmata dal proprietario…')

    function stopInner() {
      inner.forEach(close => { try { close() } catch {} })
      inner = []
    }
    const alive = version => !closed && epoch === version && active.current === runtime
    function show(phase, extra = {}) {
      if (closed) return
      setStatus(phase)
      setReport({ group: runtime.group, eligible: runtime.eligible, snapshot: runtime.snapshot,
        relayAudit: runtime.relayAudit,
        reconciliationCheckpoint: runtime.reconciliationCheckpoint,
        reconciliationRows: runtime.reconciliationRows,
        reconciliationConflict: runtime.reconciliationConflict,
        replay: runtime.replay, summary: runtime.group && runtime.snapshot
          ? historicalAttestationSummary(runtime.group, runtime.snapshot, runtime.attestations)
          : null, eventCount: runtime.events.length, ...extra })
    }
    async function refreshReconciliation(version) {
      const generation = ++runtime.reconciliationVersion
      const group = runtime.group, snap = runtime.snapshot, replay = runtime.replay
      const audit = runtime.relayAudit, attestations = runtime.attestations
      runtime.reconciliationCheckpoint = null
      // Preserve the historical replay status. In particular, do not hide
      // "Snapshot non attestabile" when there is no valid source snapshot.
      if (!alive(version) || !group || !runtime.historyChecked || !snap) return
      const checkpoint = await buildHistoricalReconciliationCheckpoint(group, snap, replay, audit, attestations)
      if (!alive(version) || generation !== runtime.reconciliationVersion ||
          runtime.group !== group || runtime.snapshot !== snap || runtime.relayAudit !== audit ||
          runtime.attestations !== attestations) return
      runtime.reconciliationCheckpoint = checkpoint
      if (checkpoint) {
        show('Proposta di riconciliazione pronta per revisione.')
      } else {
        // The checkpoint is unavailable, but that must not overwrite the
        // original historical status, nor leave a stale checkpoint on screen.
        setReport(old => old ? { ...old, group: runtime.group,
          reconciliationCheckpoint: null, reconciliationRows: runtime.reconciliationRows,
          reconciliationConflict: runtime.reconciliationConflict } : old)
      }
    }
    async function reconstruct(version) {
      const generation = ++runtime.version
      runtime.snapshot = null
      runtime.reconciliationCheckpoint = null
      show('Ricalcolo snapshot dopo la sincronizzazione…')
      if (!alive(version) || !runtime.eligible || !runtime.historyChecked) return
      const group = { ...runtime.group, _priorHistoryChecked: true,
        _historicalActivityDetected: runtime.financial,
        _priorReplayOverflow: runtime.overflow,
        _priorEvidenceOverflow: runtime.priorEvidenceOverflow }
      const events = runtime.events
      const replay = replayHistoricalFinancialEvents(group, events, { overflow: runtime.overflow })
      const snapshot = await buildHistoricalAttestationSnapshot(group, events, replay)
      if (!alive(version) || runtime.version !== generation || runtime.events !== events) return
      runtime.group = group
      runtime.replay = replay
      runtime.snapshot = snapshot
      show(snapshot ? 'Snapshot storico pronto: nessun pagamento autorizzato.' :
        `Snapshot non attestabile: ${replay.reason}`, { replay, snapshot })
      void refreshReconciliation(version)
    }
    function acceptDefinition(group) {
      if (closed || group.members.includes(pubkey) || !group._revisionId ||
          (newest && !isNewerGroupDefinition(newest, group))) return
      newest = group
      const version = ++epoch
      stopInner()
      Object.assign(runtime, { group: null, events: [], attestations: [],
        snapshot: null, overflow: false, financial: false, eligible: false,
        priorEvidenceOverflow: false, evidence: [], historyChecked: false, version: 0,
        replay: null, relayAudit: null, reconciliationRows: [], reconciliationConflict: false,
        reconciliationCheckpoint: null, reconciliationVersion: 0, reconcile: null })
      show('Verifica delle revisioni firmate dal creatore…')
      const known = new Map()
      inner.push(subscribeGroupRevisions(group, rev => {
        if (alive(version)) known.set(rev.id, rev)
      }, () => {
        if (!alive(version)) return
        const verified = verifyGroupRevisionHistory(group, [...known.values()])
        if (verified.status !== 'verified' || !verified.removedMembers.includes(pubkey)) {
          show('Storico non completo o partecipazione precedente non verificata.')
          return
        }
        const historical = { ...group, _revisionStatus: 'verified', _revisions: verified.chain,
          _auditOnly: true, _financialReviewRequired: true, _priorHistoryChecked: false }
        runtime.group = historical
        show('Verifica della richiesta di uscita e della revoca firmata…')
        const requests = []
        inner.push(subscribeMemberExitRequests(historical, parseMemberExitRequestEvent, request => {
          if (alive(version) && !requests.some(old => old.id === request.id)) requests.push(request)
        }, () => {
          if (!alive(version)) return
          const verdict = verifyMemberExitProofs(historical, requests)
          if (!formerMemberAuditEligibility(historical, pubkey, chosen, requests, verdict)) {
            show('Archivio negato: manca la prova dell’uscita volontaria finalizzata.')
            return
          }
          runtime.eligible = true
          runtime.reconcile = () => void refreshReconciliation(version)
          show('Accesso archivio verificato. Ricostruzione in sola lettura…')
          inner.push(subscribeHistoricalReconciliations(historical, row => {
            if (!alive(version)) return
            const previous = runtime.reconciliationRows
            const found = previous.find(x => x.id === row.id)
            if (found && JSON.stringify(found) !== JSON.stringify(row)) runtime.reconciliationConflict = true
            if (!found) {
              if (previous.length >= MAX_HISTORICAL_RECONCILIATIONS) runtime.reconciliationConflict = true
              else runtime.reconciliationRows = [...previous, row]
            }
            show('Firme sul checkpoint storico aggiornate.')
          }, ready => {
            if (!alive(version)) return
            runtime.group = { ...runtime.group, _reconciliationDecisionsChecked: ready }
            runtime.reconciliationCheckpoint = null
            void refreshReconciliation(version)
          }))
          inner.push(subscribeHistoricalAttestations(historical, row => {
            if (!alive(version)) return
            const old = runtime.attestations.find(x => x.id === row.id)
            if (old && JSON.stringify(old) !== JSON.stringify(row)) runtime.overflow = true
            if (!old) runtime.attestations = [...runtime.attestations, row]
            if (runtime.historyChecked) void refreshReconciliation(version)
          }))
          inner.push(subscribePriorRevisionActivity(historical, verified.chain, event => {
            if (!alive(version)) return
            const update = appendHistoricalReplayEvent(runtime.events, event)
            runtime.events = update.events
            runtime.overflow ||= update.overflow
            if (event.kind !== KIND_GROUP_INVITATION) {
              runtime.financial = true
              const evidence = priorFinancialEvidence(historical, event)
              if (!evidence) runtime.priorEvidenceOverflow = true
              else {
                const next = appendPriorEvidence(runtime.evidence, evidence)
                runtime.evidence = next.rows
                runtime.priorEvidenceOverflow ||= next.overflow
              }
            }
            if (runtime.historyChecked) void reconstruct(version)
          }, () => {
            if (!alive(version)) return
            runtime.historyChecked = true
            void reconstruct(version)
          }, diagnostic => {
            if (!alive(version)) return
            runtime.relayAudit = diagnostic
            runtime.reconciliationCheckpoint = null
            setReport(old => old ? { ...old, relayAudit: diagnostic,
              reconciliationCheckpoint: null } : old)
            if (runtime.historyChecked) void refreshReconciliation(version)
          }))
        }))
      }))
    }
    const stopDefinitions = subscribeFormerMemberGroupDefinition(chosen, acceptDefinition, () => {
      if (!newest && !closed) setStatus('Nessuna definizione attuale verificata dai relay.')
    })
    return () => {
      closed = true; ++epoch
      try { stopDefinitions() } catch {}
      stopInner()
      runtime.reconcile = null
      if (active.current === runtime) active.current = null
    }
  }, [chosen, pubkey])

  const attest = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const runtime = active.current
      if (!runtime || runtime.account !== pubkey || !runtime.eligible ||
          !runtime.historyChecked || runtime.overflow || runtime.priorEvidenceOverflow ||
          !runtime.snapshot || pendingOutbox(pubkey).length) {
        throw new Error('Accesso, snapshot o outbox non verificati')
      }
      const events = runtime.events
      const group = runtime.group
      const replay = replayHistoricalFinancialEvents(group, events, { overflow: runtime.overflow })
      const fresh = await buildHistoricalAttestationSnapshot(group, events, replay)
      if (!fresh || fresh.hash !== runtime.snapshot.hash || active.current !== runtime ||
          runtime.events !== events) throw new Error('Lo storico è cambiato: aggiorna prima della firma')
      const summary = historicalAttestationSummary(group, fresh, runtime.attestations)
      if (summary.status !== 'pending' || !summary.pending.includes(pubkey)) {
        throw new Error('Firma già presente o attestazioni in conflitto')
      }
      const signed = await publishEvent(pubkey, KIND_HISTORICAL_ATTESTATION,
        { version: 1, action: 'attest-historical-v1', groupId: group.id,
          revisionEventId: group._revisionId, snapshotHash: fresh.hash },
        historicalAttestationTags(group, fresh))
      if (active.current !== runtime || runtime.group?._revisionId !== group._revisionId) return
      const parsed = parseHistoricalAttestationEvent(signed, group)
      if (!parsed) throw new Error('Firma non valida: recupera l’evento originale dalla outbox')
      if (!runtime.attestations.some(x => x.id === parsed.id)) runtime.attestations = [...runtime.attestations, parsed]
      setReport(old => old ? { ...old,
        summary: historicalAttestationSummary(runtime.group, runtime.snapshot, runtime.attestations) } : old)
      runtime.reconcile?.()
    } catch (err) { setError(err.message || 'Errore durante la firma') }
    finally { setBusy(false) }
  }

  const signReconciliation = async () => {
    if (reconSigning.current) return
    reconSigning.current = true
    setReconBusy(true); setReconError('')
    try {
      const runtime = active.current
      if (!runtime || runtime.account !== pubkey || !runtime.eligible ||
          !runtime.historyChecked || runtime.reconciliationConflict ||
          runtime.overflow || runtime.priorEvidenceOverflow ||
          !runtime.reconciliationCheckpoint || pendingOutbox(pubkey).length) {
        throw new Error('Riconciliazione o outbox non verificate')
      }
      const events = runtime.events, group = runtime.group, audit = runtime.relayAudit
      const attestations = runtime.attestations
      const replay = replayHistoricalFinancialEvents(group, events, { overflow: runtime.overflow })
      const snapshot = await buildHistoricalAttestationSnapshot(group, events, replay)
      const checkpoint = snapshot?.hash === runtime.snapshot?.hash
        ? await buildHistoricalReconciliationCheckpoint(group, snapshot, replay, audit, attestations)
        : null
      if (!checkpoint || checkpoint.hash !== runtime.reconciliationCheckpoint.hash ||
          active.current !== runtime || runtime.events !== events ||
          runtime.group !== group || runtime.relayAudit !== audit ||
          runtime.attestations !== attestations) {
        throw new Error('Checkpoint storico modificato: non firmare')
      }
      const summary = historicalReconciliationSummary(group, checkpoint, runtime.reconciliationRows)
      if (summary.status !== 'pending' || !summary.pending.includes(pubkey))
        throw new Error('Firma precedente o checkpoint in conflitto')
      const signed = await publishEvent(pubkey, KIND_HISTORICAL_RECONCILIATION,
        { version: 1, action: 'acknowledge-reconciliation-v1', groupId: group.id,
          revisionEventId: group._revisionId, snapshotHash: checkpoint.snapshotHash,
          checkpointHash: checkpoint.hash }, historicalReconciliationTags(group, checkpoint))
      if (active.current !== runtime || runtime.group?._revisionId !== group._revisionId) return
      const parsed = parseHistoricalReconciliationEvent(signed, group)
      if (!parsed) throw new Error('Firma non valida: recupera evento originale dalla outbox')
      if (!runtime.reconciliationRows.some(x => x.id === parsed.id))
        runtime.reconciliationRows = [...runtime.reconciliationRows, parsed]
      setReport(old => old ? { ...old,
        reconciliationRows: runtime.reconciliationRows } : old)
    } catch (e) { setReconError(e.message || 'Errore firma riconciliazione') }
    finally { reconSigning.current = false; setReconBusy(false) }
  }

  return <section style={{ padding: 16, ...code }}>
    <strong style={{ fontFamily: 'var(--pixel)', fontSize: 10 }}>ARCHIVIO EX MEMBRI</strong>
    <p>Solo verifica e attestazione degli eventi Nostr osservati. Nessuna spesa, saldo pagabile o trasferimento Lightning è disponibile qui.</p>
    {!hints.length && <p>Non risultano richieste di uscita firmate da questo account sui relay collegati.</p>}
    {hints.map(h => <button key={h.id} style={{ ...btn, margin: '4px 5px 4px 0' }}
      onClick={() => setChosen(h)}>
      GRUPPO {h.groupId.slice(0, 18)} · {h.owner.slice(0, 8)}…
    </button>)}
    {chosen && <div style={{ border: '2px solid var(--blue)', marginTop: 12, padding: 12 }}>
      <strong>ACCESSO STORICO · {chosen.groupId}</strong>
      <div role="status">{status}</div>
      {report?.eligible && <div>ACCESSO ARCHIVIO VERIFICATO — SOLA LETTURA</div>}
      {report?.replay && <div>Ricostruzione: {report.replay.status} · eventi osservati {report.eventCount}</div>}
      {report?.relayAudit && <div role="status">
        <strong>CONFRONTO RELAY — ARCHIVIO</strong>
        <RelaySnapshotDiagnostics audit={report.relayAudit} />
      </div>}
      {report?.snapshot && <>
        <div>Hash osservato: <code>{report.snapshot.hash}</code></div>
        <div>Firme: {report.summary?.signed.length || 0}/{report.summary?.required.length || 0}
          · {report.summary?.status}</div>
        <button style={btn} disabled={busy || report.summary?.status !== 'pending' ||
          !report.summary?.pending.includes(pubkey)} onClick={attest}>
          {busy ? 'FIRMA IN CORSO…' : 'ATTESTA QUESTO SNAPSHOT'}
        </button>
      </>}
      {report?.eligible && <HistoricalReconciliationPanel
        key={report.reconciliationCheckpoint?.hash || report.group?._revisionId || 'pending'}
        group={report.group} checkpoint={report.reconciliationCheckpoint}
        rows={report.reconciliationRows || []}
        conflict={!!report.reconciliationConflict} account={pubkey}
        busy={reconBusy} error={reconError} auditOnly onSign={signReconciliation} />}
      {error && <p role="alert" style={{ color: 'var(--red)' }}>{error}</p>}
    </div>}
    <p style={{ color: 'var(--red)' }}>EOSE non dimostra che lo storico sia completo. Una firma non prova il pagamento e non libera nessuno da un debito.</p>
  </section>
}
