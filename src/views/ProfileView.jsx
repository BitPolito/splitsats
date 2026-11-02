import { useEffect } from 'react'
import { useStore } from '../store'
import { Avatar, Tag } from '../components/ui'
import { RELAYS } from '../lib/constants'
import { hexToNpub } from '../lib/nostr'

export default function ProfileView({ myPubkey, profiles }) {
  const logout               = useStore(s => s.logout)
  const fetchAndCacheProfile = useStore(s => s.fetchAndCacheProfile)
  const profile              = profiles[myPubkey] || {}

  // Ogni volta che si apre la pagina profilo, ri-fetcha sempre il proprio profilo
  useEffect(() => {
    if (myPubkey) fetchAndCacheProfile(myPubkey, true)
  }, [myPubkey])

  const rows = [
    ['RELAY',      `${RELAYS.length} RELAY PUBBLICI`],
    ['AUTH',       'NOSTR NIP-07'],
    ['PAGAMENTI',  'BITCOIN LIGHTNING'],
    ['STORAGE',    'RELAY + LOCALSTORAGE'],
    ['BACKEND',    'NESSUNO ✓'],
  ]

  return (
    <div style={{ flex: 1, padding: '20px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Identity */}
      <div style={{ background: 'var(--surface)', border: '2px solid var(--blue)', padding: '24px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        <Avatar pubkey={myPubkey} size="xl" />
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--pixel)', fontSize: 11, color: 'var(--text)', marginBottom: 8 }}>
            {(profile.name || profile.display_name || 'ANON').toUpperCase()}
          </div>
          {profile.about && (
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)', maxWidth: 260 }}>{profile.about}</div>
          )}
        </div>

        {/* npub */}
        <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text3)', wordBreak: 'break-all', textAlign: 'center', background: 'var(--blue-bg)', padding: '10px 14px', border: '2px solid var(--blue)', width: '100%' }}>
          {hexToNpub(myPubkey)}
        </div>

        {(profile.lud16 || profile.lud06) ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Tag variant="btc">⚡ LN</Tag>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)' }}>
              {profile.lud16 || profile.lud06}
            </span>
          </div>
        ) : (
          <div style={{ fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--red)', textAlign: 'center', lineHeight: 2, border: '2px solid var(--red)', padding: '8px 12px' }}>
            NO LIGHTNING ADDRESS.<br />
            AGGIUNGILO SU ALBY.
          </div>
        )}
      </div>

      {/* Stack info */}
      <div style={{ background: 'var(--surface)', border: '2px solid var(--blue)' }}>
        {rows.map(([label, value], i) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 16px', borderBottom: i < rows.length - 1 ? '1px solid var(--blue)' : 'none' }}>
            <span style={{ fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text3)' }}>{label}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text2)' }}>{value}</span>
          </div>
        ))}
      </div>

      {/* Relay list */}
      <div style={{ background: 'var(--surface)', border: '2px solid var(--blue)' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--blue)', fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--blue)' }}>
          // RELAY ATTIVI
        </div>
        {RELAYS.map((r, i) => (
          <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: i < RELAYS.length - 1 ? '1px solid var(--blue-bg)' : 'none' }}>
            <span style={{ width: 8, height: 8, background: 'var(--green)', border: '1px solid var(--green)', display: 'inline-block', flexShrink: 0 }} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text2)' }}>{r.replace('wss://', '')}</span>
          </div>
        ))}
      </div>

      {/* Logout */}
      <button
        onClick={logout}
        style={{ fontFamily: 'var(--pixel)', fontSize: 8, padding: '12px', border: '2px solid var(--red)', cursor: 'pointer', background: 'transparent', color: 'var(--red)', marginTop: 4, lineHeight: 1.6 }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--red)'; e.currentTarget.style.color = '#fff' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--red)' }}
      >
        DISCONNETTI
      </button>
    </div>
  )
}