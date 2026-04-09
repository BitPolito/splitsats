import { Empty, truncate } from '../components/ui'

const CATS = { food:'🍕', transport:'🚌', accommodation:'🏠', entertainment:'🎉', utilities:'⚡', other:'📦' }
const sats = (n) => Number(n).toLocaleString() + ' sat'

export default function ActivityView({ groups, myPubkey, profiles }) {
  const all = groups
    .flatMap(g => (g.expenses || []).map(e => ({ ...e, groupName: g.name })))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

  return (
    <div style={{ flex: 1, padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--blue)', marginBottom: 4 }}>
        // attività recente
      </div>

      {all.length === 0 && (
        <Empty icon="◻">
          NESSUNA ATTIVITÀ.<br />
          LE SPESE APPARIRANNO QUI.
        </Empty>
      )}

      {all.map((exp, i) => {
        const paidByMe  = exp.paidBy === myPubkey
        const payerName = profiles[exp.paidBy]?.name || truncate(exp.paidBy, 6)
        return (
          <div key={exp.id + i} style={{ background: 'var(--surface)', border: '2px solid var(--blue)', padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 36, height: 36, border: '2px solid var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0, background: 'var(--blue-bg)' }}>
              {CATS[exp.category] || '📦'}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: 'var(--pixel)', fontSize: 9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 5 }}>
                {exp.description}
              </div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>
                {exp.groupName.toUpperCase()} · {paidByMe ? 'TU' : payerName.toUpperCase()}
              </div>
            </div>
            <div style={{ fontFamily: 'var(--pixel)', fontSize: 9, color: 'var(--blue)', flexShrink: 0 }}>
              {sats(exp.amount)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
