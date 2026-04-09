import { useState } from 'react'
import { ModalShell, FormGroup, Input, Select, Button, Avatar, truncate } from '../ui'

const CATEGORIES = [
  { id: 'food',          label: 'CIBO',          icon: '🍕' },
  { id: 'transport',     label: 'TRASPORTI',      icon: '🚌' },
  { id: 'accommodation', label: 'ALLOGGIO',       icon: '🏠' },
  { id: 'entertainment', label: 'DIVERTIMENTO',   icon: '🎉' },
  { id: 'utilities',     label: 'UTENZE',         icon: '⚡' },
  { id: 'other',         label: 'ALTRO',          icon: '📦' },
]

export default function AddExpenseModal({ group, myPubkey, profiles, onConfirm, onClose }) {
  const [description, setDesc]  = useState('')
  const [amount,      setAmount] = useState('')
  const [paidBy,      setPaidBy] = useState(myPubkey)
  const [category,    setCat]    = useState('other')
  const [splitType,   setSplit]  = useState('equal')
  const [included,    setIncl]   = useState(() =>
    Object.fromEntries(group.members.map(m => [m, true]))
  )

  const splitMembers = splitType === 'equal' ? group.members : group.members.filter(m => included[m])
  const perPerson    = splitMembers.length ? Math.round(parseInt(amount || 0) / splitMembers.length) : 0

  return (
    <ModalShell onClose={onClose}>
      <div style={{ fontFamily: 'var(--pixel)', fontSize: 11, color: 'var(--blue)' }}>ADD EXPENSE</div>

      <FormGroup label="DESCRIZIONE">
        <Input value={description} onChange={e => setDesc(e.target.value)} placeholder="es. Cena al ristorante" />
      </FormGroup>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <FormGroup label="IMPORTO (SAT)">
          <Input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="21000" />
        </FormGroup>
        <FormGroup label="CATEGORIA">
          <Select value={category} onChange={e => setCat(e.target.value)}>
            {CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
          </Select>
        </FormGroup>
      </div>

      <FormGroup label="PAGATO DA">
        <Select value={paidBy} onChange={e => setPaidBy(e.target.value)}>
          {group.members.map(m => (
            <option key={m} value={m}>
              {(profiles[m]?.name || truncate(m, 10)).toUpperCase()}{m === myPubkey ? ' (TU)' : ''}
            </option>
          ))}
        </Select>
      </FormGroup>

      <FormGroup label="SPLIT">
        <div style={{ display: 'flex', gap: 8 }}>
          {['equal', 'custom'].map(t => (
            <button key={t} onClick={() => setSplit(t)} style={{
              flex: 1, fontFamily: 'var(--pixel)', fontSize: 8, padding: '10px 4px',
              border: '2px solid var(--blue)', cursor: 'pointer', lineHeight: 1.6,
              background: splitType === t ? 'var(--blue)' : 'transparent',
              color: splitType === t ? '#fff' : 'var(--blue)',
            }}>
              {t === 'equal' ? 'EQUA' : 'CUSTOM'}
            </button>
          ))}
        </div>
      </FormGroup>

      {splitType === 'custom' && (
        <div style={{ border: '2px solid var(--blue)', overflow: 'hidden' }}>
          {group.members.map((m, i) => {
            const name = profiles[m]?.name || truncate(m, 8)
            return (
              <div key={m} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: i < group.members.length - 1 ? '1px solid var(--blue)' : 'none' }}>
                <Avatar pubkey={m} />
                <span style={{ flex: 1, fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--text2)' }}>
                  {name.toUpperCase()}{m === myPubkey ? ' (TU)' : ''}
                </span>
                <input type="checkbox" checked={!!included[m]}
                  onChange={e => setIncl({ ...included, [m]: e.target.checked })}
                  style={{ accentColor: 'var(--blue)', width: 16, height: 16 }}
                />
              </div>
            )
          })}
          {amount && (
            <div style={{ padding: '8px 12px', fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--blue)', borderTop: '1px solid var(--blue)', background: 'var(--blue-bg)' }}>
              {perPerson.toLocaleString()} SAT / PERSONA
            </div>
          )}
        </div>
      )}

      <Button variant="primary" disabled={!description.trim() || !parseInt(amount)} onClick={() =>
        onConfirm({ description, amount: parseInt(amount), paidBy, category, splits: splitMembers })
      }>
        ⚡ ADD EXPENSE
      </Button>
      <Button variant="ghost" onClick={onClose}>ANNULLA</Button>
    </ModalShell>
  )
}
