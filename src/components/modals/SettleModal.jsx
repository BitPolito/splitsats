import { useState, useEffect } from 'react'
import QRCodeLib from 'qrcode'
import { ModalShell, Button, truncate } from '../ui'
import { payLightningAddress, generateInvoiceForAddress, hasWebLN } from '../../lib/lightning'

function QRCode({ value, size = 200 }) {
  const [dataUrl, setDataUrl] = useState('')
  useEffect(() => {
    if (!value) return
    QRCodeLib.toDataURL(value, { width: size, margin: 1, color: { dark: '#0000FF', light: '#ffffff' } })
      .then(setDataUrl).catch(() => setDataUrl(''))
  }, [value, size])

  if (!dataUrl) return (
    <div style={{ width: size, height: size, border: '2px solid var(--blue)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text3)' }}>
      GENERATING...
    </div>
  )
  return (
    <div style={{ border: '2px solid var(--blue)', padding: 8, display: 'inline-block', background: '#fff' }}>
      <img src={dataUrl} width={size} height={size} alt="Lightning invoice QR" style={{ display: 'block' }} />
    </div>
  )
}

export default function SettleModal({ debt, profiles, groupId, onClose, onSettled }) {
  const [status,  setStatus]  = useState('idle')
  const [errMsg,  setErrMsg]  = useState('')
  const [invoice, setInvoice] = useState('')
  const [copied,  setCopied]  = useState(false)

  const toProfile = profiles[debt.to] || {}
  const toName    = toProfile.name || truncate(debt.to, 8)
  const lnAddress = toProfile.lud16 || toProfile.lud06
  const webln     = hasWebLN()

  const handlePay = async () => {
    setStatus('resolving'); setErrMsg('')
    try {
      await payLightningAddress(lnAddress, debt.amount)
      setStatus('success')
      setTimeout(() => { onSettled(groupId, { from: debt.from, to: debt.to, amount: debt.amount }); onClose() }, 1400)
    } catch (e) { setErrMsg(e.message); setStatus('error') }
  }

  const handleShowQR = async () => {
    setStatus('resolving'); setErrMsg('')
    try {
      const pr = await generateInvoiceForAddress(lnAddress, debt.amount)
      setInvoice(pr); setStatus('qr')
    } catch (e) { setErrMsg(e.message); setStatus('error') }
  }

  const handleCopy = () => { navigator.clipboard.writeText(invoice); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  const handleManual = () => { onSettled(groupId, { from: debt.from, to: debt.to, amount: debt.amount }); onClose() }

  return (
    <ModalShell onClose={onClose}>
      <div style={{ fontFamily: 'var(--pixel)', fontSize: 11, color: 'var(--blue)' }}>
        PAY ⚡ LIGHTNING
      </div>

      {/* Amount box */}
      <div style={{ border: '2px solid var(--blue)', padding: '20px 16px', textAlign: 'center', background: 'var(--blue-bg)' }}>
        <div style={{ fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text3)', marginBottom: 8 }}>PAGAMENTO A</div>
        <div style={{ fontFamily: 'var(--pixel)', fontSize: 11, marginBottom: 8 }}>{toName.toUpperCase()}</div>
        <div style={{ fontFamily: 'var(--pixel)', fontSize: 16, color: 'var(--blue)', margin: '12px 0', lineHeight: 1.5 }}>
          {debt.amount.toLocaleString()}<br />
          <span style={{ fontSize: 9 }}>SAT</span>
        </div>
        {lnAddress
          ? <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)' }}>⚡ {lnAddress}</div>
          : <div style={{ fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--red)', border: '2px solid var(--red)', padding: '6px', marginTop: 8 }}>NO LIGHTNING ADDRESS</div>
        }
      </div>

      {/* QR */}
      {status === 'qr' && invoice && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{ fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text3)', textAlign: 'center' }}>
            SCANSIONA CON QUALSIASI WALLET
          </div>
          <QRCode value={invoice} size={200} />
          <button onClick={handleCopy} style={{ border: '2px solid var(--blue)', background: 'transparent', padding: '6px 14px', fontFamily: 'var(--pixel)', fontSize: 7, color: copied ? 'var(--green)' : 'var(--blue)', cursor: 'pointer' }}>
            {copied ? '✓ COPIATO' : 'COPIA INVOICE'}
          </button>
        </div>
      )}

      {/* Status */}
      {status === 'resolving' && <div style={{ textAlign: 'center', fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--text3)' }}>CONNECTING...</div>}
      {status === 'success'   && <div style={{ textAlign: 'center', fontFamily: 'var(--pixel)', fontSize: 9, color: 'var(--green)', border: '2px solid var(--green)', padding: '10px' }}>✓ PAYMENT SENT</div>}
      {status === 'error'     && <div style={{ fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--red)', border: '2px solid var(--red)', padding: '10px', textAlign: 'center', lineHeight: 2 }}>{errMsg}</div>}

      {!webln && status !== 'qr' && status !== 'success' && (
        <div style={{ border: '2px solid var(--blue)', padding: '10px 14px', fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text2)', lineHeight: 2, background: 'var(--blue-bg)' }}>
          ALBY NON TROVATO — USA IL QR CODE PER PAGARE.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {status !== 'qr' && status !== 'success' && (
          <Button variant="primary" disabled={!webln || !lnAddress || status === 'resolving'} onClick={handlePay}>
            {status === 'resolving' ? '// CONNECTING...' : '> PAY WITH ALBY'}
          </Button>
        )}
        {lnAddress && status !== 'qr' && status !== 'success' && (
          <Button variant="ghost" disabled={status === 'resolving'} onClick={handleShowQR}>MOSTRA QR CODE</Button>
        )}
        <button onClick={handleManual} style={{ background: 'none', border: 'none', fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text3)', cursor: 'pointer', textAlign: 'center', padding: '4px', textDecoration: 'underline', lineHeight: 2 }}>
          SEGNA COME PAGATO MANUALMENTE
        </button>
        <Button variant="ghost" onClick={onClose} style={{ color: 'var(--text3)', borderColor: 'var(--text3)' }}>ANNULLA</Button>
      </div>
    </ModalShell>
  )
}
