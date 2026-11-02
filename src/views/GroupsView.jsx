import { simplifyDebts } from '../lib/balances'
import { Avatar, SectionHeader, Button, Empty } from '../components/ui'

const sats = (n) => Number(n).toLocaleString() + ' sat'

export default function GroupsView({ groups, myPubkey, profiles, onSelectGroup, onCreateGroup }) {
  return (
    <div style={{ flex: 1, padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SectionHeader
        title={`// ${groups.length} gruppi`}
        action={
          <Button variant="ghost" size="sm" onClick={onCreateGroup} style={{ width: 'auto' }}>
            + NUOVO
          </Button>
        }
      />

      {groups.length === 0 && (
        <Empty icon="◻">
          NESSUN GRUPPO ANCORA.<br />
          CREA IL PRIMO GRUPPO<br />
          E INVITA I TUOI AMICI.
        </Empty>
      )}

      {groups.map(g => {
        const debts    = simplifyDebts(g.expenses || [], g.settlements || [], g.members || [])
        const iOwe     = debts.filter(d => d.from === myPubkey).reduce((s, d) => s + d.amount, 0)
        const owedToMe = debts.filter(d => d.to   === myPubkey).reduce((s, d) => s + d.amount, 0)
        const net      = owedToMe - iOwe

        return (
          <div
            key={g.id}
            onClick={() => onSelectGroup(g)}
            style={{
              background: 'var(--surface)', border: '2px solid var(--blue)',
              padding: '16px', cursor: 'pointer', transition: 'all 0.1s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--blue-bg)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface)' }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <div style={{ fontFamily: 'var(--pixel)', fontSize: 10, color: 'var(--text)', marginBottom: 6 }}>
                  {g.name}
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>
                  {(g.members || []).length} MEMBRI · {(g.expenses || []).length} SPESE
                </div>
              </div>
              <div style={{
                fontFamily: 'var(--pixel)', fontSize: 9, fontWeight: 700,
                color: net === 0 ? 'var(--text3)' : net > 0 ? 'var(--green)' : 'var(--red)',
                border: `2px solid ${net === 0 ? 'var(--text3)' : net > 0 ? 'var(--green)' : 'var(--red)'}`,
                padding: '4px 8px',
              }}>
                {net === 0 ? 'PARI' : net > 0 ? `+${sats(net)}` : sats(net)}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {(g.members || []).slice(0, 5).map(m => <Avatar key={m} pubkey={m} />)}
              {(g.members || []).length > 5 && (
                <span style={{ fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text3)' }}>
                  +{g.members.length - 5}
                </span>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
