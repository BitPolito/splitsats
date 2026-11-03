import { useState, useEffect, useRef } from 'react'
import QRCodeLib from 'qrcode'
import { ModalShell, Button, truncate } from '../ui'
import { payLightningAddress, prepareExternalWalletInvoice, hasWebLN } from '../../lib/lightning'
import { beginPaymentAttempt, getPaymentAttempt, updatePaymentAttempt, releaseVerifiedUnpaidAttempt, withPaymentOperationLock } from '../../lib/payment-attempts'
import { pendingOutbox } from '../../lib/nostr'

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

export default function SettleModal({ debt, profiles, groupId, myPubkey, onClose, onSettled }) {
  const [status,  setStatus]  = useState('idle')
  const [errMsg,  setErrMsg]  = useState('')
  const [invoice, setInvoice] = useState('')
  const [copied,  setCopied]  = useState(false)
  const [sent, setSent] = useState(false)
  const [deliveryUncertain, setDeliveryUncertain] = useState(false)
  const [walletSubmissionStarted, setWalletSubmissionStarted] = useState(false)
  const [walletOutcomeUnknown, setWalletOutcomeUnknown] = useState(false)
  const [walletHistoryChecked, setWalletHistoryChecked] = useState(false)
  const [attempt, setAttempt] = useState(null)
  const [attemptError, setAttemptError] = useState('')
  const [recoveryMessage, setRecoveryMessage] = useState('')
  const scope = { account: myPubkey, groupId, to: debt.to }
  const payInFlight = useRef(false)
  const qrInFlight = useRef(false)
  const recordInFlight = useRef(false)

  const toProfile = profiles[debt.to] || {}
  const toName    = toProfile.name || truncate(debt.to, 8)
  const lnAddress = toProfile.lud16 || '' // lud06 is bech32 LNURL, not a user@domain Lightning Address
  const webln     = hasWebLN()

  // Refresh and account changes must not reset the wallet-submission guard.
  useEffect(() => {
    setWalletHistoryChecked(false)
    const refresh = () => {
      if (myPubkey !== debt.from) {
        setAttemptError('Identità Nostr diversa dal debitore: pagamento bloccato')
        setAttempt(null)
        return
      }
      try {
        setAttempt(getPaymentAttempt({ account: myPubkey, groupId, to: debt.to }))
        setAttemptError('')
      } catch (error) {
        setAttempt(null)
        setAttemptError(error.message)
      }
    }
    refresh()
    window.addEventListener('storage', refresh)
    return () => window.removeEventListener('storage', refresh)
  }, [myPubkey, groupId, debt.from, debt.to])

  const settlementQueued = () => {
    // Do not create a second signed settlement when an ACK is still uncertain.
    try {
      return pendingOutbox(myPubkey).some(({ event }) =>
        event.kind === 9001 && event.tags?.some(t => t[0] === 'g' && t[1] === groupId))
    } catch { return true } // Unreadable outbox = fail closed.
  }

  const handlePay = async () => {
    if (payInFlight.current || qrInFlight.current || sent || walletSubmissionStarted || deliveryUncertain || attempt || attemptError || settlementQueued()) return
    payInFlight.current = true
    let walletCompleted = false
    let submitted = false
    setStatus('resolving'); setErrMsg('')
    try {
      // Web Locks serialize submissions between same-origin tabs when supported.
      await withPaymentOperationLock(scope, async () => {
        // Recheck synchronously, not only via React state: stale UI must not pay.
        const existing = getPaymentAttempt(scope)
        if (existing) {
          setAttempt(existing)
          throw new Error('Esiste già un tentativo: verifica il wallet prima di ripagare')
        }
        await payLightningAddress(lnAddress, debt.amount, {
          onWalletSubmission: async () => {
            // A signer switch while the invoice was resolving must fail closed.
            const activeSigner = await window.nostr?.getPublicKey?.()
            if (activeSigner !== myPubkey) throw new Error('Account Nostr cambiato: pagamento annullato prima dell’invio al wallet')
            // Storage write MUST succeed before invoking the external wallet.
            const record = beginPaymentAttempt(scope, debt.amount)
            submitted = true
            setAttempt(record)
            setWalletSubmissionStarted(true)
          },
        })
        walletCompleted = true
        setSent(true)
        setAttempt(updatePaymentAttempt(scope, 'wallet-reported'))
        const claimEventId = await onSettled(groupId, { from: debt.from, to: debt.to, amount: debt.amount,
          method: 'webln', walletReported: true })
        if (!/^[a-f0-9]{64}$/.test(claimEventId || '')) throw new Error('ID della dichiarazione Nostr non disponibile: verifica la cronologia')
      setAttempt(updatePaymentAttempt(scope, 'claim-pending', { claimEventId }))
        setStatus('pending')
      })
    } catch (e) {
      if (submitted && !walletCompleted) {
        // All failures after handing an invoice to WebLN remain ambiguous.
        try { setAttempt(updatePaymentAttempt(scope, 'outcome-unknown')) }
        catch { /* submitted lock remains persisted */ }
      }
      if (['RELAY_PUBLICATION_UNKNOWN', 'OUTBOX_PENDING'].includes(e.code)) setDeliveryUncertain(true)
      if (e.code === 'WALLET_PAYMENT_OUTCOME_UNKNOWN' || submitted) setWalletOutcomeUnknown(true)
      setErrMsg((walletCompleted ? 'Il wallet ha segnalato il pagamento, ma la richiesta non è confermata sui relay. NON pagare di nuovo. ' :
        submitted ? 'Esito del wallet incerto. NON ripetere il pagamento. ' :
        'Nessuna nuova richiesta di pagamento inviata al wallet. ') + (e.message || 'Errore'))
      setStatus('error')
    } finally {
      payInFlight.current = false
    }
  }

  const handleShowQR = async () => {
    if (qrInFlight.current || payInFlight.current || status === 'resolving' || status === 'recording' ||
        walletSubmissionStarted || deliveryUncertain || attempt || attemptError || settlementQueued()) return
    qrInFlight.current = true
    setStatus('resolving'); setErrMsg('')
    try {
      const { invoice: pr, attempt: record } = await prepareExternalWalletInvoice(
        lnAddress, debt.amount, scope, {
          ensureSigner: async () => {
            const activeSigner = await window.nostr?.getPublicKey?.()
            if (myPubkey !== debt.from || activeSigner !== myPubkey) {
              throw new Error('Account Nostr diverso dal debitore: QR annullato prima della visualizzazione')
            }
            if (settlementQueued()) throw new Error('Dichiarazione Nostr in coda: non generare altri pagamenti')
          },
        })
      setAttempt(record)
      setInvoice(pr)
      setCopied(false)
      setStatus('qr')
    } catch (e) {
      // Surface an attempt created in another tab instead of silently retrying.
      try { setAttempt(getPaymentAttempt(scope)) }
      catch (error) { setAttemptError(error.message) }
      setErrMsg(e.message || 'Non è stato possibile preparare il QR')
      setStatus('error')
    } finally {
      qrInFlight.current = false
    }
  }

  const handleCopy = async () => {
    if (!invoice || attempt?.status !== 'submitted') return
    try {
      // Revalidate the persisted guard and active account, even if the UI is stale.
      const saved = getPaymentAttempt(scope)
      if (saved?.status !== 'submitted' || saved.amount !== debt.amount ||
          await window.nostr?.getPublicKey?.() !== myPubkey) {
        throw new Error('Tentativo o account modificato: QR non copiato')
      }
      await navigator.clipboard.writeText(invoice)
      setCopied(true)
    } catch (error) {
      setErrMsg(error.message || 'Impossibile copiare la invoice')
      setStatus('error')
    }
  }

  const handleManual = async () => {
    if (recordInFlight.current || attemptError || attempt?.status === 'claim-pending' ||
        (attempt && !walletHistoryChecked) || settlementQueued()) return
    recordInFlight.current = true
    setStatus('recording'); setErrMsg('')
    try {
      if (attempt?.status === 'submitted') {
        setAttempt(updatePaymentAttempt(scope, 'outcome-unknown'))
      }
      // When recovering a timed-out wallet call, this is a user declaration,
      // not an independently verified WebLN receipt.
      const walletReported = !!(sent || attempt?.status === 'wallet-reported')
      const claimEventId = await onSettled(groupId, { from: debt.from, to: debt.to, amount: debt.amount,
        method: walletReported ? 'webln' : 'manual', walletReported })
      if (attempt) setAttempt(updatePaymentAttempt(scope, 'claim-pending', { claimEventId }))
      setStatus('pending')
    } catch (e) {
      if (['RELAY_PUBLICATION_UNKNOWN', 'OUTBOX_PENDING'].includes(e.code)) setDeliveryUncertain(true)
      setErrMsg(e.message || 'Impossibile registrare la richiesta'); setStatus('error')
    } finally {
      recordInFlight.current = false
    }
  }

  const handleVerifiedUnpaid = () => {
    if (!attempt || !walletHistoryChecked || attempt.status === 'claim-pending' || settlementQueued()) return
    const phrase = window.prompt('Dopo aver controllato il wallet E contattato il destinatario, scrivi NESSUN PAGAMENTO solo se sei certo che non sono stati trasferiti satoshi:')
    if (phrase !== 'NESSUN PAGAMENTO') return
    try {
      releaseVerifiedUnpaidAttempt(scope, phrase)
      setAttempt(null)
      setInvoice('')
      setCopied(false)
      setWalletSubmissionStarted(false)
      setWalletOutcomeUnknown(false)
      setWalletHistoryChecked(false)
      setSent(false)
      setDeliveryUncertain(false)
      setErrMsg('')
      setStatus('idle')
      setRecoveryMessage('Tentativo sbloccato manualmente. Verifica nuovamente il saldo prima di pagare.')
    } catch (error) { setAttemptError(error.message) }
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
      {status === 'qr' && invoice && attempt?.status === 'submitted' && !attemptError && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{ fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text3)', textAlign: 'center' }}>
            SCANSIONA CON QUALSIASI WALLET
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red)', textAlign: 'center', lineHeight: 1.5 }}>
            QR registrato localmente. Se il wallet paga, NON richiedere un secondo QR:
            controlla la cronologia e chiedi la conferma del destinatario.
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

      {attemptError && <div role="alert" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 11 }}>Archivio Lightning non leggibile: {attemptError}. Nessun pagamento consentito.</div>}
      {attempt && <div role="status" style={{ border: '2px solid var(--red)', padding: 12, fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.7 }}>
        TENTATIVO LIGHTNING SALVATO — {attempt.status.toUpperCase()}<br />
        {attempt.amount} sat · {new Date(attempt.startedAt).toLocaleString()}<br />
        NON PAGARE DI NUOVO: questa protezione rimane attiva anche dopo un refresh.
        {attempt.status === 'claim-pending'
          ? <div>Richiesta registrata. Attendi la conferma firmata del destinatario.</div>
          : <>
            <div>Controlla la cronologia del wallet e contatta il destinatario prima di dichiarare o sbloccare il tentativo.</div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10 }}>
              <input type="checkbox" checked={walletHistoryChecked} onChange={e => setWalletHistoryChecked(e.target.checked)} />
              Ho verificato il wallet e contattato il destinatario. So se il pagamento è stato effettuato.
            </label>
            <button onClick={handleVerifiedUnpaid} disabled={!walletHistoryChecked || deliveryUncertain}
              style={{ marginTop: 10, background: 'transparent', color: 'var(--red)', border: '1px solid var(--red)', padding: 8, fontFamily: 'var(--mono)', fontSize: 10 }}>
              SBLOCCA SOLO SE NON È STATO PAGATO
            </button>
          </>}
      </div>}
      {walletOutcomeUnknown && !attempt && !deliveryUncertain && <div role="alert" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 11 }}>Esito WebLN incerto. Non inviare altri satoshi prima di aver controllato il wallet.</div>}
      {recoveryMessage && <div role="status" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{recoveryMessage}</div>}

      {deliveryUncertain && <div style={{ fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--red)', lineHeight: 2 }}>Esito della pubblicazione incerto. Controlla la cronologia dopo una nuova sincronizzazione; non ripagare e non inviare una seconda dichiarazione ora.</div>}

      {!webln && status !== 'qr' && status !== 'pending' && (
        <div style={{ border: '2px solid var(--blue)', padding: '10px 14px', fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text2)', lineHeight: 2, background: 'var(--blue-bg)' }}>
          ALBY NON TROVATO — USA IL QR CODE PER PAGARE.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {status !== 'qr' && status !== 'pending' && (
          <Button variant="primary" disabled={!webln || !lnAddress || sent || walletSubmissionStarted || deliveryUncertain || !!attempt || !!attemptError || status === 'resolving' || status === 'recording'} onClick={handlePay}>
            {status === 'resolving' ? '// CONNECTING...' : '> PAY WITH ALBY'}
          </Button>
        )}
        {lnAddress && !sent && !walletSubmissionStarted && !deliveryUncertain && !attempt && !attemptError && status !== 'qr' && status !== 'pending' && (
          <Button variant="ghost" disabled={status === 'resolving' || status === 'recording'} onClick={handleShowQR}>MOSTRA QR CODE</Button>
        )}
        {!deliveryUncertain && !attemptError && attempt?.status !== 'claim-pending' && status !== 'pending' && status !== 'recording' && status !== 'resolving' && <button onClick={handleManual} disabled={!!attempt && !walletHistoryChecked} style={{ background: 'none', border: 'none', fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text3)', cursor: 'pointer', textAlign: 'center', padding: '4px', textDecoration: 'underline', lineHeight: 2 }}>
          {attempt ? 'PAGAMENTO VERIFICATO: CHIEDI CONFERMA (NON RIPAGARE)' : sent ? 'RIPROVA REGISTRAZIONE (NON RIPAGARE)' : walletOutcomeUnknown ? 'HO VERIFICATO IL PAGAMENTO: CHIEDI CONFERMA' : status === 'qr' ? 'HO PAGATO CON QR: CHIEDI CONFERMA' : 'DICHIARA PAGAMENTO MANUALE'}
        </button>}
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text3)', lineHeight: 1.5 }}>
          Le dichiarazioni non riducono i debiti. Solo una conferma firmata dal destinatario aggiorna il saldo. Controlla sempre il wallet prima di dichiarare un pagamento.
        </div>
        <Button variant="ghost" disabled={status === 'resolving' || status === 'recording'} onClick={onClose} style={{ color: 'var(--text3)', borderColor: 'var(--text3)' }}>{status === 'pending' ? 'CHIUDI' : 'ANNULLA'}</Button>
      </div>
    </ModalShell>
  )
}
