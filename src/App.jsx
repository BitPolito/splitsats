import { useState } from 'react'
import { useStore } from './store'
import { Toast } from './components/ui'

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
  const loading          = useStore(s => s.loading)
  const createGroup      = useStore(s => s.createGroup)
  const addExpense       = useStore(s => s.addExpense)
  const recordSettlement = useStore(s => s.recordSettlement)

  const [tab,           setTab]           = useState('groups')
  const [selectedGroup, setSelectedGroup] = useState(null)
  const [modal,         setModal]         = useState(null)
  const [settleDebt,    setSettleDebt]    = useState(null)

  const liveGroup = selectedGroup
    ? groups.find(g => g.id === selectedGroup.id) || selectedGroup
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

      {/* ── Group detail or main tabs ── */}
      {liveGroup ? (
        <GroupDetail
          group={liveGroup} myPubkey={pubkey} profiles={profiles}
          onBack={() => setSelectedGroup(null)}
          onAddExpense={() => setModal('addExpense')}
          onSettle={(debt) => { setSettleDebt(debt); setModal('settle') }}
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
          onConfirm={async (expense) => { await addExpense(liveGroup.id, expense); setModal(null) }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'settle' && settleDebt && (
        <SettleModal
          debt={settleDebt} profiles={profiles} groupId={liveGroup?.id}
          onSettled={async (gid, data) => await recordSettlement(gid, data)}
          onClose={() => { setModal(null); setSettleDebt(null) }}
        />
      )}

      {toast && <Toast message={toast} onDone={clearToast} />}
    </div>
  )
}
