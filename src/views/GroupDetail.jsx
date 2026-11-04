import { useState } from 'react'
import { simplifyDebts } from '../lib/balances'
import { approvedSettlements, settlementStatus } from '../lib/settlement-status'
import { getPaymentAttempt } from '../lib/payment-attempts'
import { Avatar, Tag, Empty, SectionHeader, Button, truncate } from '../components/ui'
import { hexToNpub, isValidPubkey } from '../lib/nostr'
import { CONSENT_POLICY, invitationSummary } from '../lib/group-invitations'
import { EXPENSE_POLICY, expenseApprovalSummary } from '../lib/expense-approvals'
import { expenseCancellationSummary, cancellationParticipants } from '../lib/expense-cancellations'
import { priorEvidenceCounts } from '../lib/prior-financial-evidence'

const sats = (n) => Number(n).toLocaleString() + ' sat'
const CATS = { food:'🍕', transport:'🚌', accommodation:'🏠', entertainment:'🎉', utilities:'⚡', other:'📦' }

const statBox = (label, value, color) => (
  <div key={label} style={{ border: '2px solid var(--blue)', padding: '10px 12px', background: 'var(--surface)' }}>
    <div style={{ fontFamily: 'var(--pixel)', fontSize: 7, color: 'var(--text3)', marginBottom: 6, textTransform: 'uppercase' }}>{label}</div>
    <div style={{ fontFamily: 'var(--pixel)', fontSize: 9, color }}>{value}</div>
  </div>
)

export default function GroupDetail({ group, myPubkey, profiles, onBack, onAddExpense, onSettle, onConfirmSettlement, onInviteDecision, onExpenseDecision, onCancelExpense, onAddMember, onRequestExit, onFinalizeExit }) {
  const [tab, setTab] = useState('expenses')
  const [confirmingId, setConfirmingId] = useState(null)
  const [confirmationError, setConfirmationError] = useState('')
  const [cancelBusy, setCancelBusy] = useState(null)
  const [leaveBusy, setLeaveBusy] = useState(false)
  const [leaveError, setLeaveError] = useState('')
  const [memberInput, setMemberInput] = useState('')
  const [memberBusy, setMemberBusy] = useState(false)
  const [memberError, setMemberError] = useState('')
  const [expenseBusy, setExpenseBusy] = useState(null)
  const [expenseError, setExpenseError] = useState('')
  const [invitationBusy, setInvitationBusy] = useState(false)
  const [invitationError, setInvitationError] = useState('')
  const invitation = invitationSummary(group, group._inviteDecisions || [])
  const inviteLocked = group._consentPolicy === CONSENT_POLICY && invitation.status !== 'accepted'
  const myInvitation = (group._inviteDecisions || []).find(x => x.member === myPubkey)
  const respondToInvitation = async (decision) => {
    if (invitationBusy) return
    setInvitationBusy(true); setInvitationError('')
    try { await onInviteDecision(decision) }
    catch (error) { setInvitationError(error.message || 'Errore invito Nostr') }
    finally { setInvitationBusy(false) }
  }

  const locked = Boolean(group._revisionId &&
    (group._revisionStatus !== 'verified' || group._financialReviewRequired)) || inviteLocked || !!group._expenseReviewRequired
  // Never render an incomplete ledger as if everybody were settled.
  const expenses = locked ? [] : (group.expenses || [])
  const settlements = locked ? [] : (group.settlements || [])
  const members = group.members || []
  const confirmations = locked ? [] : (group.confirmations || [])
  const approved = approvedSettlements(settlements, confirmations)

  const debts      = simplifyDebts(expenses, approved, members)
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
          {statBox('TOTALE',    locked ? '—' : sats(totalSpent), 'var(--text)')}
          {statBox('DEVI',      locked ? '—' : sats(myDebt), 'var(--red)')}
          {statBox('TI DEVONO', locked ? '—' : sats(myCredit), 'var(--green')}
        </div>
      </div>

      {locked && (
        <div role="alert" style={{ padding: '10px 16px', borderBottom: '2px solid var(--red)',
          color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 11 }}>
          Registro delle revisioni Nostr incompleto, in conflitto o con membri rimossi.
          Saldi e pagamenti bloccati fino alla riconciliazione dello storico.
        </div>
      )}
      {group._historicalActivityDetected && (
        <section role="alert" style={{ padding: '10px 16px', borderBottom: '2px solid var(--red)',
          fontFamily: 'var(--mono)', fontSize: 10, lineHeight: 1.7 }}>
          <strong>STORICO FINANZIARIO PRECEDENTE — BLOCCO ATTIVO</strong>
          {(() => {
            const rows = group._priorFinancialEvidence || []
            const c = priorEvidenceCounts(rows)
            return <div>Eventi identificati: {rows.length} · spese {c.expenses} · dichiarazioni {c.settlements}
              · conferme {c.confirmations} · decisioni {c.decisions} · annullamenti {c.cancellations}</div>
          })()}
          {group._priorEvidenceOverflow && <div>Registro incompleto o oltre limite: revisione manuale obbligatoria.</div>}
          {(group._priorFinancialEvidence || []).slice(0, 10).map(e =>
            <div key={e.eventId}>kind:{e.kind} · rev:{e.revisionId.slice(0, 10)} · id:{e.eventId.slice(0, 12)}</div>)}
          {(group._priorFinancialEvidence || []).length > 10 && <div>Altri eventi nel registro: non mostrati qui.</div>}
          <div>Questi dati sono prove Nostr, non debiti calcolati. Nessun pagamento automatico.</div>
        </section>
      )}
      {group._consentPolicy === CONSENT_POLICY && (
        <section role="status" style={{ padding: '12px 16px', borderBottom: '2px solid var(--blue)',
          fontFamily: 'var(--mono)', fontSize: 11, lineHeight: 1.8 }}>
          {invitation.status === 'accepted' ? 'Inviti firmati: tutti i partecipanti hanno accettato.' :
            invitation.status === 'declined' ? 'Un invitato ha rifiutato. Nessun nuovo debito puo essere creato.' :
            invitation.status === 'conflict' ? 'Decisioni Nostr contraddittorie: gruppo bloccato.' :
            `In attesa di ${invitation.pending.length} adesioni firmate. Nessun debito e attivo.`}
          {invitationError && <div role="alert" style={{ color: 'var(--red)' }}>{invitationError}</div>}
          {group._revisionStatus === 'verified' && myPubkey !== group.pubkey &&
            !myInvitation && invitation.status === 'pending' && <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button disabled={invitationBusy} onClick={() => respondToInvitation('accept')} style={{
                border: '2px solid var(--blue)', background: 'var(--blue)', color: '#fff',
                padding: '9px', fontFamily: 'var(--pixel)', fontSize: 7, cursor: 'pointer' }}>
                ACCETTA INVITO
              </button>
              <button disabled={invitationBusy} onClick={() => respondToInvitation('decline')} style={{
                border: '2px solid var(--red)', background: 'var(--surface)', color: 'var(--red)',
                padding: '9px', fontFamily: 'var(--pixel)', fontSize: 7, cursor: 'pointer' }}>
                RIFIUTA INVITO
              </button>
            </div>}
          {myInvitation && <div>LA TUA RISPOSTA: {myInvitation.decision === 'accept' ? 'ACCETTATO' : 'RIFIUTATO'}</div>}
        </section>
      )}
      {group._expenseReviewRequired && (
        <div role="alert" style={{ padding: '10px 16px', color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 11 }}>
          Una spesa e contestata o contiene decisioni contraddittorie. Saldi e pagamenti bloccati fino a revisione.
        </div>
      )}
      {group._revisionStatus === 'legacy' && (
        <div role="status" style={{ padding: '10px 16px', fontFamily: 'var(--mono)', fontSize: 10 }}>
          Gruppo legacy: nessun registro firmato delle revisioni. Verifica i saldi con i partecipanti.
        </div>
      )}
      {group._legacyQuarantined && (
        <div role="alert" style={{ padding: '10px 16px', borderBottom: '2px solid var(--red)', color: 'var(--red)', background: 'var(--surface)', fontFamily: 'var(--mono)', fontSize: 11 }}>
          Gruppi con lo stesso ID ma autori diversi: le vecchie transazioni prive del riferimento `a` sono state escluse dai saldi. Verifica lo storico prima di effettuare pagamenti.
        </div>
      )}

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
            action={<Button variant="ghost" size="sm" disabled={locked} onClick={onAddExpense} style={{ width: 'auto' }}>+ ADD</Button>}
          />
          {expenseError && <div role="alert" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 11 }}>{expenseError}</div>}
          {group._expensePolicy === EXPENSE_POLICY && (group.proposedExpenses || []).map(exp => {
            const result = expenseApprovalSummary(group, exp, group._expenseDecisions || [])
            const cancellation = expenseCancellationSummary(group, exp,
              group._cancellationDecisions || [], result.status)
            if (result.status === 'approved' && cancellation.status === 'none') return null
            const canDecide = result.status === 'pending' && result.pending.includes(myPubkey) && !locked
            const canCancel = result.status === 'disputed' &&
              (cancellation.status === 'none' || cancellation.status === 'pending') &&
              cancellationParticipants(exp).includes(myPubkey) &&
              !cancellation.signed.includes(myPubkey) && !inviteLocked &&
              group._revisionStatus === 'verified' && !group._financialReviewRequired &&
              !(group.settlements || []).length && !(group.confirmations || []).length
            return <div key={exp._eventId} style={{ background: 'var(--surface)', border: '2px solid var(--blue)', padding: '12px', fontFamily: 'var(--mono)', fontSize: 11 }}>
              <div><span>{exp.description}</span> — {sats(exp.amount)}</div>
              <div>{cancellation.status === 'cancelled' ? 'SPESA ANNULLATA CON CONSENSO' :
                result.status === 'disputed' ? `SPESA CONTESTATA · ${cancellation.signed.length} FIRME ANNULLAMENTO` :
                result.status === 'conflict' ? 'DECISIONI IN CONFLITTO' :
                `IN ATTESA DI ${result.pending.length} APPROVAZIONI`}</div>
              {canCancel && <button disabled={cancelBusy === exp._eventId} onClick={async () => {
                if (!window.confirm('Annullare definitivamente questa proposta? Tutti i partecipanti coinvolti devono firmare.')) return
                setCancelBusy(exp._eventId); setExpenseError('')
                try { await onCancelExpense(exp._eventId) }
                catch (error) { setExpenseError(error.message || 'Annullamento non riuscito') }
                finally { setCancelBusy(null) }
              }}>FIRMA ANNULLAMENTO</button>}
              {canDecide && <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button disabled={expenseBusy === exp._eventId} onClick={async () => {
                  setExpenseBusy(exp._eventId); setExpenseError('')
                  try { await onExpenseDecision(exp._eventId, 'approve') }
                  catch (error) { setExpenseError(error.message || 'Approvazione non riuscita') }
                  finally { setExpenseBusy(null) }
                }}>APPROVA SPESA</button>
                <button disabled={expenseBusy === exp._eventId} onClick={async () => {
                  setExpenseBusy(exp._eventId); setExpenseError('')
                  try { await onExpenseDecision(exp._eventId, 'dispute') }
                  catch (error) { setExpenseError(error.message || 'Contestazione non riuscita') }
                  finally { setExpenseBusy(null) }
                }}>CONTESTA SPESA</button>
              </div>}
            </div>
          })}
          {expenses.length === 0 && !(group.proposedExpenses || []).length && <Empty icon="◻">NESSUNA SPESA ANCORA.</Empty>}
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
          {locked && <Empty icon="!">SALDI NON VERIFICATI.</Empty>}
          {!locked && debts.length === 0 && <Empty icon="✓">TUTTI IN PARI!</Empty>}
          {debts.map((d, i) => {
            const fromName = profiles[d.from]?.name || truncate(d.from, 6)
            const toName   = profiles[d.to]?.name   || truncate(d.to, 6)
            const isMe     = d.from === myPubkey
            const hasPending = settlements.some(s => s.from === d.from && s.to === d.to &&
              settlementStatus(s, confirmations) !== 'confirmed')
            let localAttempt = false
            if (isMe) {
              try { localAttempt = !!getPaymentAttempt({ account: myPubkey, groupId: group.id, to: d.to }) }
              catch { localAttempt = true } // Corrupted/unavailable storage: never present as safe to pay.
            }
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
                  <button disabled={locked || (hasPending && !localAttempt)} onClick={() => onSettle(d)} style={{
                    fontFamily: 'var(--pixel)', fontSize: 8, background: 'var(--blue)', color: '#fff',
                    border: '2px solid var(--blue)', padding: '7px 12px', cursor: 'pointer',
                  }}>
                    {localAttempt ? 'VERIFICA ⚡' : hasPending ? 'IN ATTESA' : 'PAY ⚡'}
                  </button>
                )}
              </div>
            )
          })}

          {settlements.length > 0 && <>
            <div style={{ fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--text3)', marginTop: 8 }}>// richieste di pagamento</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, lineHeight: 1.6, color: 'var(--text3)' }}>
              Solo i pagamenti confermati dal destinatario sono sottratti ai debiti. Le vecchie registrazioni richiedono una nuova conferma.
            </div>
            {confirmationError && <div role="alert" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 11 }}>{confirmationError}</div>}
            {settlements.map((s, i) => {
              const fromName = profiles[s.from]?.name || truncate(s.from, 6)
              const toName   = profiles[s.to]?.name   || truncate(s.to, 6)
              const status = settlementStatus(s, confirmations)
              return (
                <div key={s._eventId || i} style={{ background: 'var(--surface2)', border: '2px solid var(--text3)', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <Avatar pubkey={s.from} />
                  <div style={{ flex: 1, fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--text2)' }}>
                    {s.from === myPubkey ? 'TU' : fromName.toUpperCase()} → {s.to === myPubkey ? 'TU' : toName.toUpperCase()}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontFamily: 'var(--pixel)', fontSize: 8, color: status === 'confirmed' ? 'var(--green)' : 'var(--text3)' }}>{sats(s.amount)}</div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: status === 'confirmed' ? 'var(--green)' : 'var(--text3)', marginTop: 6 }}>
                      {status === 'confirmed' ? 'CONFERMATO DAL DESTINATARIO' : status === 'wallet-reported' ? 'WEBLN DICHIARATO: IN ATTESA' : 'DICHIARATO: IN ATTESA'}
                    </div>
                  </div>
                  {s.to === myPubkey && status !== 'confirmed' && (
                    <button disabled={locked || confirmingId === s._eventId} style={{ border: '2px solid var(--blue)', background: 'var(--blue)', color: 'white', padding: 8, fontFamily: 'var(--pixel)', fontSize: 7, cursor: 'pointer' }}
                      onClick={async () => {
                        if (!window.confirm(`Confermi di aver ricevuto ${s.amount} sat? Controlla prima il tuo wallet.`)) return
                        setConfirmingId(s._eventId); setConfirmationError('')
                        try { await onConfirmSettlement(s._eventId) }
                        catch (error) { setConfirmationError(error.message || 'Errore di conferma') }
                        finally { setConfirmingId(null) }
                      }}>
                      {confirmingId === s._eventId ? 'INVIO...' : 'CONFERMA RICEZIONE'}
                    </button>
                  )}
                </div>
              )
            })}
          </>}
        </>}

        {/* MEMBRI */}
        {tab === 'members' && <>
          <div style={{ fontFamily: 'var(--pixel)', fontSize: 8, color: 'var(--blue)', marginBottom: 4 }}>// membri del gruppo</div>
          {leaveError && <div role="alert" style={{ color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 11 }}>{leaveError}</div>}
          {group._consentPolicy === CONSENT_POLICY && members.length >= 3 && (
            myPubkey !== group.pubkey ? (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>
                {(group._memberExitRequests || []).some(r => r.member === myPubkey && r.revisionEventId === group._revisionId)
                  ? 'RICHIESTA USCITA INVIATA — ATTENDI LA CONFERMA DEL CREATORE'
                  : <button disabled={leaveBusy || locked || !group._financialHistoryChecked} onClick={async () => {
                      setLeaveBusy(true); setLeaveError('')
                      try { await onRequestExit() } catch(e) { setLeaveError(e.message || 'Richiesta non riuscita') }
                      finally { setLeaveBusy(false) }
                    }}>RICHIEDI USCITA</button>}
              </div>
            ) : (group._memberExitRequests || []).filter(r => r.revisionEventId === group._revisionId).map(r =>
              <div key={r.id} style={{ padding: 8, border: '1px solid var(--blue)', fontFamily: 'var(--mono)', fontSize: 10 }}>
                USCITA RICHIESTA: {truncate(hexToNpub(r.member), 22)}
                <button disabled={leaveBusy || locked || !group._financialHistoryChecked} onClick={async () => {
                  setLeaveBusy(true); setLeaveError('')
                  try { await onFinalizeExit(r.member) } catch(e) { setLeaveError(e.message || 'Uscita non riuscita') }
                  finally { setLeaveBusy(false) }
                }}>CONFERMA USCITA</button>
              </div>
            )
          )}
          {myPubkey === group.pubkey && group._consentPolicy === CONSENT_POLICY && <div style={{ border: '2px solid var(--blue)', padding: 10, fontFamily: 'var(--mono)', fontSize: 10 }}>
            <div style={{ marginBottom: 8 }}>AGGIUNTA MEMBRI: disponibile solo nei gruppi senza spese, pagamenti o proposte. Tutti gli invitati dovranno accettare di nuovo la revisione firmata. Uscita e rimozione non sono ancora supportate.</div>
            <input aria-label="Nuovo membro Nostr" placeholder="npub1… o hex pubkey"
              value={memberInput} onChange={e => { setMemberInput(e.target.value); setMemberError('') }}
              style={{ width: '100%', padding: 7, boxSizing: 'border-box', marginBottom: 6 }} />
            <button disabled={memberBusy || !isValidPubkey(memberInput.trim()) ||
              !group._financialHistoryChecked || locked}
              onClick={async () => {
                setMemberBusy(true); setMemberError('')
                try { await onAddMember(memberInput); setMemberInput('') }
                catch (error) { setMemberError(error.message || 'Aggiornamento non riuscito') }
                finally { setMemberBusy(false) }
              }}>AGGIUNGI MEMBRO</button>
            {memberError && <div role="alert" style={{ color: 'var(--red)', marginTop: 8 }}>{memberError}</div>}
          </div>}
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
