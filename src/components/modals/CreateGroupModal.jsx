import { useState } from 'react'
import { ModalShell, FormGroup, Input, Button, Avatar, Tag, truncate } from '../ui'
import { isValidPubkey, npubToHex, hexToNpub } from '../../lib/nostr'

export default function CreateGroupModal({ myPubkey, onConfirm, onClose }) {
  const [name,        setName]      = useState('')
  const [memberInput, setInput]     = useState('')
  const [members,     setMembers]   = useState([myPubkey])
  const [inputError,  setInputError] = useState('')

  const addMember = () => {
    const raw = memberInput.trim()
    if (!raw) return
    if (!isValidPubkey(raw)) { setInputError('NPUB O HEX NON VALIDO'); return }
    const hex = npubToHex(raw)
    if (members.includes(hex)) { setInputError('MEMBRO GIÀ PRESENTE'); return }
    setMembers([...members, hex]); setInput(''); setInputError('')
  }

  return (
    <ModalShell onClose={onClose}>
      <div style={{ fontFamily: 'var(--pixel)', fontSize: 11, color: 'var(--blue)' }}>NEW GROUP</div>

      <FormGroup label="NOME GRUPPO">
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="es. Viaggio a Berlino" />
      </FormGroup>

      <FormGroup label="AGGIUNGI MEMBRI (NPUB O HEX)">
        <div style={{ display: 'flex', gap: 8 }}>
          <Input value={memberInput} onChange={e => { setInput(e.target.value); setInputError('') }}
            placeholder="npub1… o hex pubkey" style={{ flex: 1 }}
            onKeyDown={e => e.key === 'Enter' && addMember()}
          />
          <Button variant="ghost" size="sm" onClick={addMember} style={{ width: 'auto' }}>+</Button>
        </div>
        {inputError && (
          <div style={{ fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--red)', marginTop: 4, lineHeight: 2 }}>{inputError}</div>
        )}
      </FormGroup>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {members.map(hex => (
          <div key={hex} style={{ display: 'flex', alignItems: 'center', gap: 10, border: '2px solid var(--blue)', padding: '8px 12px', background: 'var(--blue-bg)' }}>
            <Avatar pubkey={hex} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {truncate(hexToNpub(hex), 22)}
            </span>
            {hex === myPubkey
              ? <Tag variant="btc">YOU</Tag>
              : <button onClick={() => setMembers(members.filter(x => x !== hex))}
                  style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontFamily: 'var(--pixel)', fontSize: 9 }}>✕</button>
            }
          </div>
        ))}
      </div>

      <Button variant="primary" disabled={!name.trim() || members.length < 2}
        onClick={() => onConfirm({ name: name.trim(), members })}>
        CREATE GROUP
      </Button>
      <Button variant="ghost" onClick={onClose}>ANNULLA</Button>
    </ModalShell>
  )
}
