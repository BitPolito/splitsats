import { useEffect, useState } from 'react'
import { useStore } from './store'
import { Toast } from './components/ui'
import { pendingOutbox, retryOutbox, subscribeOutbox } from './lib/nostr'
import { groupAddress } from './lib/group-history'
import { CONSENT_POLICY, invitationSummary } from './lib/group-invitations'

import LoginView   from './views/LoginView'
import GroupsView  from './views/GroupsView'
import GroupDetail from './views/GroupDetail'
import ActivityView from './views/ActivityView'
import ProfileView  from './views/ProfileView'

import CreateGroupModal from './components/modals/CreateGroupModal'
import AddExpenseModal  from './components/modals/AddExpenseModal'
import SettleModal      from './components/modals/SettleModal'

export default function App() {
  const pubkey           = useStore(s => s.pubkey)
  const groups           = useStore(s => s.groups)
  const profiles         = useStore(s => s.profiles)
  const toast            = useStore(s => s.toast)
  const relayStatus      = useStore(s => s.relayStatus)
  const clearToast       = useStore(s => s.clearToast)
  const login            = useStore(s => s.login)
  const initSession      = useStore(s => s.initSession)
  const restoreSession   = useStore(s => s.restoreSession)
  const loading          = useStore(s => s.loading)
  const createGroup      = useStore(s => s.createGroup)
  const addExpense       = useStore(s => s.addExpense)
  const recordSettlement = useStore(s => s.recordSettlement)
  const confirmSettlement = useStore(s => s.confirmSettlement)
  const decideInvitation = useStore(s => s.decideInvitation)
  const decideExpense = useStore(s => s.decideExpense)
  const addGroupMember = useStore(s => s.addGroupMember)
  const requestGroupExit = useStore(s => s.requestGroupExit)
  const finalizeGroupExit = useStore(s => s.finalizeGroupExit)
  const cancelDisputedExpense = useStore(s => s.cancelDisputedExpense)
  const attestHistoricalSnapshot = useStore(s => s.attestHistoricalSnapshot)

  // Revalidate the cached identity with the active NIP-07 signer before displaying data.
  useEffect(() => { restoreSession() }, [restoreSession])

  // Restore relay subscriptions when a verified session is loaded after a refresh.
  useEffect(() => { if (pubkey) initSession(pubkey) }, [pubkey, initSession])

  const [queuedEvents, setQueuedEvents] = useState([])
  const [queueError, setQueueError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const [retryMessage, setRetryMessage] = useState('')

  useEffect(() => {
    if (!pubkey) { setQueuedEvents([]); setQueueError(''); return }
    // Avoid displaying another account's previously loaded local queue.
    setQueuedEvents([])
    setRetryMessage('')
    const refresh = () => {
      try { setQueuedEvents(pendingOutbox(pubkey)); setQueueError('') }
      catch (error) { setQueuedEvents([]); setQueueError(error.message) }
    }
    refresh()
    const unsubscribe = subscribeOutbox(changedPubkey => {
      if (changedPubkey === pubkey) refresh()
    })
    // Also notice writes from other tabs without sending any event automatically.
    window.addEventListener('storage', refresh)
    return () => { unsubscribe(); window.removeEventListener('storage', refresh) }
  }, [pubkey])

  const handleRetryOutbox = async () => {
    if (retrying || !pubkey) return
    setRetrying(true)
    setRetryMessage('')
    try {
      const results = await retryOutbox(pubkey)
      const ok = results.filter(r => r.ok).length
      const failed = results.length - ok
      setRetryMessage(failed
        ? `${ok} eventi accettati, ${failed} ancora in attesa. Non ripetere l’operazione originale.`
        : `${ok} eventi accettati dai relay. Verifica la sincronizzazione dei gruppi.`)
    } catch (error) { setRetryMessage(error.message || 'Errore durante la sincronizzazione') }
    finally { setRetrying(false) }
  }

  const [tab,           setTab]           = useState('groups')
  const [selectedGroup, setSelectedGroup] = useState(null)
  const [modal,         setModal]         = useState(null)
  const [settleDebt,    setSettleDebt]    = useState(null)

  // Never select a same-d group belonging to a different Nostr author,
  // and never fall back to a stale group removed from the verified state.
  const liveGroup = selectedGroup
    ? groups.find(g => groupAddress(g) === groupAddress(selectedGroup)) || null
    : null

  if (!pubkey) return <LoginView onLogin={login} loading={loading} />

  const TABS = [['groups', 'GRUPPI'], ['activity', 'ATTIVITÀ'], ['profile', 'PROFILO']]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh', maxWidth: 520, margin: '0 auto', background: 'var(--bg)' }}>

      {/* ── Header ── */}
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 18px', borderBottom: '2px solid var(--blue)',
        background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 100,
      }}>
        <span style={{ fontFamily: 'var(--pixel)', fontSize: 12, color: 'var(--blue)', letterSpacing: '-0.01em' }}>
          SPLITSATS
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            display: 'inline-block', width: 8, height: 8,
            background: relayStatus > 0 ? 'var(--green)' : 'var(--red)',
            border: '1px solid currentColor',
          }} title={`${relayStatus} relay`} />
          <button
            onClick={() => { setSelectedGroup(null); setTab('profile') }}
            style={{
              fontFamily: 'var(--pixel)', fontSize: 7, background: 'transparent',
              border: '1.5px solid var(--blue)', padding: '4px 8px',
              color: 'var(--blue)', cursor: 'pointer',
            }}
          >
            {pubkey.slice(0, 8)}…
          </button>
        </div>
      </header>

      {/* ── Signed outbox: retry existing IDs, never repeat payments ── */}
      {(queuedEvents.length > 0 || queueError || retryMessage) && (
        <section role="status" style={{ margin: '10px 16px 0', border: '2px solid var(--blue)', background: 'var(--blue-bg)', padding: 12 }}>
          <div style={{ fontFamily: 'var(--pixel)', fontSize: 8, lineHeight: 1.8, color: 'var(--blue)' }}>
            OUTBOX NOSTR — {queuedEvents.length} EVENTI IN ATTESA
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.6, color: 'var(--text2)' }}>
            {queueError || 'Gli eventi sono già firmati e salvati su questo dispositivo. Ritenta solo la pubblicazione, non il pagamento Lightning.'}
          </div>
          {queuedEvents.map(({ event }) => (
            <div key={event.id} style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', marginTop: 5 }}>
              Evento {event.kind} · {event.id.slice(0, 12)}…
            </div>
          ))}
          {retryMessage && <div role="alert" style={{ fontFamily: 'var(--mono)', fontSize: 11, marginTop: 8 }}>{retryMessage}</div>}
          {queuedEvents.length > 0 && !queueError && (
            <button onClick={handleRetryOutbox} disabled={retrying} style={{ marginTop: 10, border: '2px solid var(--blue)', background: 'var(--blue)', padding: '8px 12px', fontFamily: 'var(--pixel)', fontSize: 7, color: '#fff', cursor: retrying ? 'wait' : 'pointer' }}>
              {retrying ? 'SINCRONIZZAZIONE...' : 'RIPROVA OUTBOX'}
            </button>
          )}
        </section>
      )}

      {/* ── Group detail or main tabs ── */}
      {liveGroup ? (
        <GroupDetail
          group={liveGroup} myPubkey={pubkey} profiles={profiles}
          onBack={() => setSelectedGroup(null)}
          onAddExpense={() => setModal('addExpense')}
          onSettle={(debt) => { setSettleDebt(debt); setModal('settle') }}
          onConfirmSettlement={(settlementId) => confirmSettlement(groupAddress(liveGroup), settlementId)}
          onInviteDecision={(decision) => decideInvitation(groupAddress(liveGroup), decision)}
          onExpenseDecision={(expenseEventId, decision) => decideExpense(groupAddress(liveGroup), expenseEventId, decision)}
          onAddMember={(member) => addGroupMember(groupAddress(liveGroup), member)}
          onRequestExit={() => requestGroupExit(groupAddress(liveGroup))}
          onFinalizeExit={(member) => finalizeGroupExit(groupAddress(liveGroup), member)}
          onCancelExpense={(expenseEventId) => cancelDisputedExpense(groupAddress(liveGroup), expenseEventId)}
          onAttestHistorical={() => attestHistoricalSnapshot(groupAddress(liveGroup))}
        />
      ) : (
        <>
          <nav style={{ display: 'flex', background: 'var(--surface)', borderBottom: '2px solid var(--blue)' }}>
            {TABS.map(([key, label]) => (
              <button key={key} onClick={() => setTab(key)} style={{
                flex: 1, padding: '11px 4px',
                fontFamily: 'var(--pixel)', fontSize: 7, fontWeight: 400,
                textAlign: 'center', cursor: 'pointer', background: tab === key ? 'var(--blue)' : 'transparent',
                border: 'none', borderRight: key !== 'profile' ? '2px solid var(--blue)' : 'none',
                color: tab === key ? '#fff' : 'var(--blue)',
                letterSpacing: '0.04em', transition: 'all 0.1s',
              }}>
                {label}
              </button>
            ))}
          </nav>

          {tab === 'groups'   && <GroupsView   groups={groups} myPubkey={pubkey} profiles={profiles} onSelectGroup={setSelectedGroup} onCreateGroup={() => setModal('createGroup')} />}
          {tab === 'activity' && <ActivityView groups={groups} myPubkey={pubkey} profiles={profiles} />}
          {tab === 'profile'  && <ProfileView  myPubkey={pubkey} profiles={profiles} />}
        </>
      )}

      {/* ── Modals ── */}
      {modal === 'createGroup' && (
        <CreateGroupModal
          myPubkey={pubkey}
          onConfirm={async (data) => { await createGroup(data); setModal(null) }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'addExpense' && liveGroup && (
        <AddExpenseModal
          group={liveGroup} myPubkey={pubkey} profiles={profiles}
          onConfirm={async (expense) => { await addExpense(groupAddress(liveGroup), expense); setModal(null) }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'settle' && settleDebt && (
        <SettleModal
          debt={settleDebt} profiles={profiles} groupId={liveGroup?.id} myPubkey={pubkey}
          onSettled={async (_legacyGroupId, data) => await recordSettlement(groupAddress(liveGroup), data)}
          ensureGroupCurrent={() => {
            const g = useStore.getState().getGroup(groupAddress(liveGroup))
            if (!g || (g._revisionId &&
                (g._revisionStatus !== 'verified' || g._financialReviewRequired)) ||
                (g._consentPolicy === CONSENT_POLICY &&
                  invitationSummary(g, g._inviteDecisions || []).status !== 'accepted') ||
                g._expenseReviewRequired) {
              throw new Error('Registro gruppo non verificato: nessun pagamento deve partire')
            }
          }}
          onClose={() => { setModal(null); setSettleDebt(null) }}
        />
      )}

      {toast && <Toast message={toast} onDone={clearToast} />}
    </div>
  )
}
