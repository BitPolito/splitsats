import { useState, useEffect, useRef } from 'react'
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
  const [sent, setSent] = useState(false)
  const [deliveryUncertain, setDeliveryUncertain] = useState(false)
  const [walletSubmissionStarted, setWalletSubmissionStarted] = useState(false)
  const [walletOutcomeUnknown, setWalletOutcomeUnknown] = useState(false)
  const [walletHistoryChecked, setWalletHistoryChecked] = useState(false)
  const payInFlight = useRef(false)
  const recordInFlight = useRef(false)

  const toProfile = profiles[debt.to] || {}
  const toName    = toProfile.name || truncate(debt.to, 8)
  const lnAddress = toProfile.lud16 || '' // lud06 is bech32 LNURL, not a user@domain Lightning Address
  const webln     = hasWebLN()

  const handlePay = async () => {
    if (payInFlight.current || sent || walletSubmissionStarted || deliveryUncertain) return
    payInFlight.current = true
    let walletCompleted = false
    setStatus('resolving'); setErrMsg('')
    try {
      await payLightningAddress(lnAddress, debt.amount, {
        onWalletSubmission: () => setWalletSubmissionStarted(true),
      })
      // A wallet success response is not an independent settlement proof.
      // Do NOT mark the balance paid until the recipient signs a confirmation.
      walletCompleted = true
      setSent(true)
      await onSettled(groupId, { from: debt.from, to: debt.to, amount: debt.amount,
        method: 'webln', walletReported: true })
      setStatus('pending')
    } catch (e) {
      if (['RELAY_PUBLICATION_UNKNOWN', 'OUTBOX_PENDING'].includes(e.code)) setDeliveryUncertain(true)
      if (e.code === 'WALLET_PAYMENT_OUTCOME_UNKNOWN') setWalletOutcomeUnknown(true)
      setErrMsg((walletCompleted ? 'Il wallet ha segnalato il pagamento, ma non siamo riusciti a pubblicare la richiesta. NON pagare di nuovo. ' :
        e.code === 'WALLET_PAYMENT_OUTCOME_UNKNOWN' ? 'Il wallet potrebbe aver pagato. NON ripetere il pagamento. ' :
        'Errore prima dell’invio al wallet: nessun pagamento richiesto. ') + (e.message || 'Errore'))
      setStatus('error')
    } finally {
      payInFlight.current = false
    }
  }

  const handleShowQR = async () => {
    if (walletSubmissionStarted || deliveryUncertain) return
    setStatus('resolving'); setErrMsg('')
    try {
      const pr = await generateInvoiceForAddress(lnAddress, debt.amount)
      setInvoice(pr); setStatus('qr')
    } catch (e) { setErrMsg(e.message); setStatus('error') }
  }

  const handleCopy = async () => {
    try { await navigator.clipboard.writeText(invoice); setCopied(true) }
    catch { setErrMsg('Impossibile copiare la invoice') }
  }

  const handleManual = async () => {
    if (recordInFlight.current || (walletOutcomeUnknown && !walletHistoryChecked)) return
    recordInFlight.current = true
    setStatus('recording'); setErrMsg('')
    try {
      await onSettled(groupId, { from: debt.from, to: debt.to, amount: debt.amount,
        method: sent ? 'webln' : 'manual', walletReported: sent })
      setStatus('pending')
    } catch (e) {
      if (['RELAY_PUBLICATION_UNKNOWN', 'OUTBOX_PENDING'].includes(e.code)) setDeliveryUncertain(true)
      setErrMsg(e.message || 'Impossibile registrare la richiesta'); setStatus('error')
    } finally {
      recordInFlight.current = false
    }
  }

  return (
    <ModalShell onClose={() => { if (status !== 'resolving' && status !== 'recording') onClose() }}>
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
      {status === 'pending'   && <div style={{ textAlign: 'center', fontFamily: 'var(--pixel)', fontSize: 9, color: 'var(--green)', border: '2px solid var(--green)', padding: '10px' }}>✓ RICHIESTA REGISTRATA: ATTESA CONFERMA DEL DESTINATARIO</div>}
      {status === 'recording' && <div style={{ textAlign: 'center', fontFamily: 'var(--pixel)', fontSize: 8 }}>SALVATAGGIO SU NOSTR...</div>}
      {status === 'error'     && <div style={{ fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--red)', border: '2px solid var(--red)', padding: '10px', textAlign: 'center', lineHeight: 2 }}>{errMsg}</div>}

      {walletOutcomeUnknown && !deliveryUncertain && <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red)', lineHeight: 1.7 }}>
        Il risultato WebLN non è affidabile. Controlla la cronologia del wallet e chiedi al destinatario prima di dichiarare un pagamento. Non premere PAY di nuovo: potrebbe inviare altri satoshi.
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10 }}>
          <input type="checkbox" checked={walletHistoryChecked} onChange={e => setWalletHistoryChecked(e.target.checked)} />
          Ho verificato nella cronologia che il pagamento è stato eseguito e voglio richiedere la conferma del destinatario.
        </label>
      </div>}

      {deliveryUncertain && <div style={{ fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--red)', lineHeight: 2 }}>Esito della pubblicazione incerto. Controlla la cronologia dopo una nuova sincronizzazione; non ripagare e non inviare una seconda dichiarazione ora.</div>}

      {!webln && status !== 'qr' && status !== 'pending' && (
        <div style={{ border: '2px solid var(--blue)', padding: '10px 14px', fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text2)', lineHeight: 2, background: 'var(--blue-bg)' }}>
          ALBY NON TROVATO — USA IL QR CODE PER PAGARE.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {status !== 'qr' && status !== 'pending' && (
          <Button variant="primary" disabled={!webln || !lnAddress || sent || walletSubmissionStarted || deliveryUncertain || status === 'resolving' || status === 'recording'} onClick={handlePay}>
            {status === 'resolving' ? '// CONNECTING...' : '> PAY WITH ALBY'}
          </Button>
        )}
        {lnAddress && !sent && !walletSubmissionStarted && !deliveryUncertain && status !== 'qr' && status !== 'pending' && (
          <Button variant="ghost" disabled={status === 'resolving' || status === 'recording'} onClick={handleShowQR}>MOSTRA QR CODE</Button>
        )}
        {!deliveryUncertain && status !== 'pending' && status !== 'recording' && status !== 'resolving' && <button onClick={handleManual} disabled={walletOutcomeUnknown && !walletHistoryChecked} style={{ background: 'none', border: 'none', fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text3)', cursor: 'pointer', textAlign: 'center', padding: '4px', textDecoration: 'underline', lineHeight: 2 }}>
          {sent ? 'RIPROVA REGISTRAZIONE (NON RIPAGARE)' : walletOutcomeUnknown ? 'HO VERIFICATO IL PAGAMENTO: CHIEDI CONFERMA' : status === 'qr' ? 'HO PAGATO CON QR: CHIEDI CONFERMA' : 'DICHIARA PAGAMENTO MANUALE'}
        </button>}
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', lineHeight: 1.5 }}>
          Le dichiarazioni non riducono i debiti. Solo una conferma firmata dal destinatario aggiorna il saldo. Controlla sempre il wallet prima di dichiarare un pagamento.
        </div>
        <Button variant="ghost" disabled={status === 'resolving' || status === 'recording'} onClick={onClose} style={{ color: 'var(--text3)', borderColor: 'var(--text3)' }}>{status === 'pending' ? 'CHIUDI' : 'ANNULLA'}</Button>
      </div>
    </ModalShell>
  )
}
