import { useStore } from '../store'

export default function LoginView({ onLogin, loading }) {
  const hasNostr = typeof window.nostr !== 'undefined'
  const error    = useStore(s => s.error)

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px 24px', gap: 40, minHeight: '100vh', background: 'var(--bg)' }}>

      {/* Logo */}
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: 'var(--pixel)', fontSize: 22, color: 'var(--blue)', letterSpacing: '-0.02em', lineHeight: 1.4 }}>
          SPLIT<br />SATS
        </div>
        <div style={{ marginTop: 16, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)', letterSpacing: '0.05em' }}>
          SPESE CONDIVISE · BITCOIN · NOSTR
        </div>
      </div>

      {/* Feature list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 340 }}>
        {[
          ['[NIP-07]', 'Identità decentralizzata via Nostr'],
          ['[BTC]',    'Pagamenti in Bitcoin Lightning'],
          ['[P2P]',    'Zero server, zero database'],
        ].map(([tag, text]) => (
          <div key={tag} style={{ display: 'flex', alignItems: 'center', gap: 12, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)', borderLeft: '3px solid var(--blue)', paddingLeft: 12 }}>
            <span style={{ fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--blue)', flexShrink: 0 }}>{tag}</span>
            {text}
          </div>
        ))}
      </div>

      {/* Login card */}
      <div style={{ width: '100%', maxWidth: 340, background: 'var(--surface)', border: '2px solid var(--blue)', padding: '28px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          // connetti wallet nostr
        </div>

        {!hasNostr && (
          <div style={{ border: '2px solid var(--blue)', padding: '12px 14px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text2)', lineHeight: 1.7, background: 'var(--blue-bg)' }}>
            Installa <strong>Alby</strong> o <strong>nos2x</strong> per continuare.
          </div>
        )}

        {error && (
          <div style={{ border: '2px solid var(--red)', padding: '10px 14px', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red)', lineHeight: 1.6 }}>
            ERR: {error}
          </div>
        )}

        <button
          disabled={!hasNostr || loading}
          onClick={onLogin}
          style={{
            fontFamily: 'var(--pixel)', fontSize: 9, padding: '14px',
            border: '2px solid var(--blue)', borderRadius: 0,
            cursor: hasNostr && !loading ? 'pointer' : 'not-allowed',
            background: hasNostr && !loading ? 'var(--blue)' : 'var(--surface2)',
            color: hasNostr && !loading ? '#fff' : 'var(--text3)',
            transition: 'all 0.1s', lineHeight: 1.6,
          }}
        >
          {loading ? '// CONNECTING...' : '> CONNECT WALLET'}
        </button>

        <div style={{ fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text3)', textAlign: 'center', lineHeight: 2 }}>
          YOUR PRIVATE KEY NEVER LEAVES THE BROWSER
        </div>
      </div>
    </div>
  )
}
