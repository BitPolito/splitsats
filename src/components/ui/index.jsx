import { useEffect } from 'react'

const truncate = (s, n = 8) => s ? s.slice(0, n) + '…' : ''

// ─── Pixel-style border box ───────────────────────────────────────────────────
const card = {
  background: 'var(--surface)',
  border: '2px solid var(--blue)',
  borderRadius: 0,
}

export function Avatar({ pubkey, size = 'sm' }) {
  const initials = pubkey ? pubkey.slice(0, 2).toUpperCase() : '??'
  const dim = size === 'lg' ? 36 : size === 'xl' ? 48 : 26
  const fs  = size === 'lg' ? 9  : size === 'xl' ? 12  : 7
  return (
    <div style={{
      width: dim, height: dim, border: '2px solid var(--blue)',
      background: 'var(--blue-bg)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--pixel)', fontSize: fs,
      color: 'var(--blue)', flexShrink: 0,
    }}>
      {initials}
    </div>
  )
}

export function Tag({ children, variant = 'default' }) {
  const styles = {
    default: { border: '1.5px solid var(--text3)', color: 'var(--text3)', bg: 'transparent' },
    btc:     { border: '1.5px solid var(--blue)',  color: 'var(--blue)',  bg: 'var(--blue-bg)' },
    green:   { border: '1.5px solid var(--green)', color: 'var(--green)', bg: 'rgba(0,85,0,0.06)' },
    red:     { border: '1.5px solid var(--red)',   color: 'var(--red)',   bg: 'rgba(187,0,0,0.06)' },
  }
  const s = styles[variant] || styles.default
  return (
    <span style={{
      display: 'inline-block', fontFamily: 'var(--pixel)', fontSize: 8,
      padding: '4px 8px', border: s.border,
      color: s.color, background: s.bg, borderRadius: 0,
      lineHeight: 1.4,
    }}>
      {children}
    </span>
  )
}

export function Button({ children, variant = 'ghost', size = 'md', disabled, onClick, style }) {
  const base = {
    fontFamily: 'var(--pixel)', fontWeight: 400, borderRadius: 0,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'all 0.1s', opacity: disabled ? 0.4 : 1,
    letterSpacing: '0em', textAlign: 'center', lineHeight: 1.6,
    border: '2px solid',
  }
  const sizes = {
    sm: { padding: '6px 10px', fontSize: 8 },
    md: { padding: '12px 18px', fontSize: 9, width: '100%' },
  }
  const variants = {
    primary: { background: 'var(--blue)', borderColor: 'var(--blue)', color: '#fff' },
    ghost:   { background: 'transparent', borderColor: 'var(--blue)', color: 'var(--blue)' },
    danger:  { background: 'transparent', borderColor: 'var(--red)',  color: 'var(--red)' },
  }
  return (
    <button disabled={disabled} onClick={onClick}
      style={{ ...base, ...sizes[size], ...variants[variant], ...style }}
      onMouseEnter={e => { if (!disabled && variant === 'ghost') { e.currentTarget.style.background = 'var(--blue)'; e.currentTarget.style.color = '#fff' } }}
      onMouseLeave={e => { if (!disabled && variant === 'ghost') { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--blue)' } }}
    >
      {children}
    </button>
  )
}

export function Toast({ message, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 2800); return () => clearTimeout(t) }, [onDone])
  return (
    <div style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      background: 'var(--blue)', border: '2px solid var(--blue-dim)', borderRadius: 0,
      padding: '10px 18px', fontFamily: 'var(--pixel)', fontSize: 9, color: '#fff',
      zIndex: 999, whiteSpace: 'nowrap',
      animation: 'toastIn 0.15s steps(4)',
    }}>
      {message}
      <style>{`@keyframes toastIn { from { opacity:0; transform:translateX(-50%) translateY(6px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }`}</style>
    </div>
  )
}

export function Empty({ icon, children }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 24px', color: 'var(--text3)', fontFamily: 'var(--pixel)', fontSize: 9, lineHeight: 2.4 }}>
      <div style={{ fontSize: 24, marginBottom: 20 }}>{icon}</div>
      {children}
    </div>
  )
}

export function SectionHeader({ title, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
      <span style={{ fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--blue)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</span>
      {action}
    </div>
  )
}

export function FormGroup({ label, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</label>
      {children}
    </div>
  )
}

export function Input({ value, onChange, placeholder, type = 'text', style, onKeyDown, onFocus, onBlur }) {
  return (
    <input
      type={type} value={value} onChange={onChange} placeholder={placeholder}
      onKeyDown={onKeyDown}
      style={{
        background: 'var(--surface)', border: '2px solid var(--border)',
        borderRadius: 0, padding: '10px 12px', color: 'var(--text)',
        fontFamily: 'var(--mono)', fontSize: 13, outline: 'none', width: '100%',
        ...style,
      }}
      onFocus={e => { e.target.style.borderColor = 'var(--blue)'; e.target.style.background = 'var(--blue-bg)'; onFocus?.() }}
      onBlur={e  => { e.target.style.borderColor = 'var(--border)'; e.target.style.background = 'var(--surface)'; onBlur?.() }}
    />
  )
}

export function Select({ value, onChange, children, style }) {
  return (
    <select value={value} onChange={onChange} style={{
      background: 'var(--surface)', border: '2px solid var(--border)',
      borderRadius: 0, padding: '10px 12px', color: 'var(--text)',
      fontFamily: 'var(--mono)', fontSize: 13, outline: 'none', width: '100%',
      cursor: 'pointer', ...style,
    }}>
      {children}
    </select>
  )
}

export function ModalShell({ onClose, children }) {
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,255,0.12)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 200 }}
      onClick={onClose}
    >
      <div
        style={{ background: 'var(--surface)', border: '2px solid var(--blue)', borderBottom: 'none', borderRadius: 0, padding: '28px 20px 40px', width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 18, maxHeight: '90vh', overflowY: 'auto' }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ width: 32, height: 3, background: 'var(--blue)', margin: '0 auto -8px' }} />
        {children}
      </div>
    </div>
  )
}

export { truncate }
