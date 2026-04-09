import { useState } from 'react'
import { simplifyDebts } from '../lib/balances'
import { Avatar, Tag, Empty, SectionHeader, Button, truncate } from '../components/ui'
import { hexToNpub } from '../lib/nostr'

const sats = (n) => Number(n).toLocaleString() + ' sat'
const CATS = { food:'🍕', transport:'🚌', accommodation:'🏠', entertainment:'🎉', utilities:'⚡', other:'📦' }

const statBox = (label, value, color) => (
  <div key={label} style={{ border: '2px solid var(--blue)', padding: '10px 12px', background: 'var(--surface)' }}>
    <div style={{ fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text3)', marginBottom: 6, textTransform: 'uppercase' }}>{label}</div>
    <div style={{ fontFamily: 'var(--pixel)', fontSize: 9, color }}>{value}</div>
  </div>
)

export default function GroupDetail({ group, myPubkey, profiles, onBack, onAddExpense, onSettle }) {
  const [tab, setTab] = useState('expenses')

  const expenses    = group.expenses    || []
  const settlements = group.settlements || []
  const members     = group.members     || []

  const debts      = simplifyDebts(expenses, settlements, members)
  const totalSpent = expenses.reduce((s, e) => s + e.amount, 0)
  const myDebt     = debts.filter(d => d.from === myPubkey).reduce((s, d) => s + d.amount, 0)
  const myCredit   = debts.filter(d => d.to   === myPubkey).reduce((s, d) => s + d.amount, 0)

  const SUBTABS = [['expenses','SPESE'],['balances','SALDI'],['members','MEMBRI']]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>

      {/* Header */}
      <div style={{ background: 'var(--surface)', borderBottom: '2px solid var(--blue)', padding: '12px 16px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <button onClick={onBack} style={{
            background: 'transparent', border: '2px solid var(--blue)', padding: '5px 10px',
            color: 'var(--blue)', fontFamily: 'var(--pixel)', fontSize: 7, cursor: 'pointer',
          }}>
            ← BACK
          </button>
          <span style={{ fontFamily: 'var(--pixel)', fontSize: 10, color: 'var(--text)' }}>{group.name}</span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          {statBox('TOTALE',    sats(totalSpent), 'var(--text)')}
          {statBox('DEVI',      sats(myDebt),     'var(--red)')}
          {statBox('TI DEVONO', sats(myCredit),   'var(--green)')}
        </div>
      </div>

      {/* Sub-nav */}
      <nav style={{ display: 'flex', background: 'var(--surface)', borderBottom: '2px solid var(--blue)' }}>
        {SUBTABS.map(([key, label], i) => (
          <button key={key} onClick={() => setTab(key)} style={{
            flex: 1, padding: '10px 4px', fontFamily: 'var(--pixel)', fontSize: 7,
            textAlign: 'center', cursor: 'pointer',
            background: tab === key ? 'var(--blue)' : 'transparent',
            border: 'none', borderRight: i < 2 ? '2px solid var(--blue)' : 'none',
            color: tab === key ? '#fff' : 'var(--blue)',
            transition: 'all 0.1s',
          }}>
            {label}
          </button>
        ))}
      </nav>

      {/* Content */}
      <div style={{ flex: 1, padding: '18px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>

        {/* SPESE */}
        {tab === 'expenses' && <>
          <SectionHeader
            title={`// ${expenses.length} spese`}
            action={<Button variant="ghost" size="sm" onClick={onAddExpense} style={{ width: 'auto' }}>+ ADD</Button>}
          />
          {expenses.length === 0 && <Empty icon="◻">NESSUNA SPESA ANCORA.</Empty>}
          {[...expenses].reverse().map(exp => {
            const paidByMe  = exp.paidBy === myPubkey
            const payerName = profiles[exp.paidBy]?.name || truncate(exp.paidBy, 6)
            return (
              <div key={exp.id} style={{ background: 'var(--surface)', border: '2px solid var(--blue)', padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 36, height: 36, border: '2px solid var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0, background: 'var(--blue-bg)' }}>
                  {CATS[exp.category] || '📦'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--pixel)', fontSize: 9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 5 }}>{exp.description}</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>
                    {paidByMe ? 'HAI PAGATO TU' : `PAGATO DA ${payerName.toUpperCase()}`}
                  </div>
                </div>
                <div style={{ fontFamily: 'var(--pixel)', fontSize: 9, color: 'var(--blue)', flexShrink: 0, textAlign: 'right' }}>
                  {sats(exp.amount)}
                </div>
              </div>
            )
          })}
        </>}

        {/* SALDI */}
        {tab === 'balances' && <>
          <div style={{ fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--blue)', textTransform: 'uppercase', marginBottom: 4 }}>// chi deve cosa</div>
          {debts.length === 0 && <Empty icon="✓">TUTTI IN PARI!</Empty>}
          {debts.map((d, i) => {
            const fromName = profiles[d.from]?.name || truncate(d.from, 6)
            const toName   = profiles[d.to]?.name   || truncate(d.to, 6)
            const isMe     = d.from === myPubkey
            return (
              <div key={i} style={{ background: 'var(--surface)', border: `2px solid ${isMe ? 'var(--red)' : 'var(--blue)'}`, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <Avatar pubkey={d.from} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--pixel)', fontSize: 8, marginBottom: 4 }}>
                    <span style={{ color: isMe ? 'var(--red)' : 'var(--text)' }}>{isMe ? 'TU' : fromName.toUpperCase()}</span>
                    <span style={{ color: 'var(--text3)', margin: '0 6px' }}>→</span>
                    <span style={{ color: d.to === myPubkey ? 'var(--green)' : 'var(--text)' }}>{d.to === myPubkey ? 'TU' : toName.toUpperCase()}</span>
                  </div>
                  <div style={{ fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--blue)' }}>{sats(d.amount)}</div>
                </div>
                {isMe && (
                  <button onClick={() => onSettle(d)} style={{
                    fontFamily: 'var(--pixel)', fontSize: 8, background: 'var(--blue)', color: '#fff',
                    border: '2px solid var(--blue)', padding: '7px 12px', cursor: 'pointer',
                  }}>
                    PAY ⚡
                  </button>
                )}
              </div>
            )
          })}

          {settlements.length > 0 && <>
            <div style={{ fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--text3)', marginTop: 8 }}>// pagamenti registrati</div>
            {settlements.map((s, i) => {
              const fromName = profiles[s.from]?.name || truncate(s.from, 6)
              const toName   = profiles[s.to]?.name   || truncate(s.to, 6)
              return (
                <div key={i} style={{ background: 'var(--surface2)', border: '2px solid var(--text3)', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, opacity: 0.7 }}>
                  <Avatar pubkey={s.from} />
                  <div style={{ flex: 1, fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--text2)' }}>
                    {s.from === myPubkey ? 'TU' : fromName.toUpperCase()} → {s.to === myPubkey ? 'TU' : toName.toUpperCase()}
                  </div>
                  <div style={{ fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--green)' }}>✓ {sats(s.amount)}</div>
                </div>
              )
            })}
          </>}
        </>}

        {/* MEMBRI */}
        {tab === 'members' && <>
          <div style={{ fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--blue)', marginBottom: 4 }}>// membri del gruppo</div>
          {members.map(m => {
            const profile   = profiles[m] || {}
            const name      = profile.name || truncate(m, 10)
            const totalPaid = expenses.filter(e => e.paidBy === m).reduce((s, e) => s + e.amount, 0)
            const lnAddr    = profile.lud16 || profile.lud06
            return (
              <div key={m} style={{ background: 'var(--surface)', border: `2px solid ${m === myPubkey ? 'var(--blue)' : 'var(--border)'}`, padding: '14px', display: 'flex', alignItems: 'center', gap: 12 }}>
                <Avatar pubkey={m} size="lg" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--pixel)', fontSize: 9, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                    {name.toUpperCase()}
                    {m === myPubkey && <Tag variant="btc">YOU</Tag>}
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {truncate(hexToNpub(m), 20)}
                  </div>
                  {lnAddr && <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--blue)', marginTop: 3 }}>⚡ {lnAddr}</div>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text3)', marginBottom: 3 }}>PAGATO</div>
                  <div style={{ fontFamily: 'var(--pixel)', fontSize: 9, color: 'var(--blue)' }}>{sats(totalPaid)}</div>
                </div>
              </div>
            )
          })}
        </>}
      </div>
    </div>
  )
}
