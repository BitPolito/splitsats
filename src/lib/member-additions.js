// Phase 2D-A: owner-signed additions, restricted to groups with no financial
// history. An addition does NOT authorize removal or settlement of old debts.
// Relay completeness is not cryptographic finality: an EOSE is a best-effort
// synchronization barrier; old participants must consent again to the new head.
import { groupAddress } from './group-history.js'

const KEY = /^[0-9a-f]{64}$/
const ACTIVITY = [
  'proposedExpenses', 'expenses', 'settlements', 'confirmations',
  '_expenseDecisions', '_cancellationDecisions',
]

// Throws rather than returning a misleading 'safe' bool if remote history,
// outbox, or signed revision chain has not been reconstructed.
export function assertCanAddGroupMember(group, actor, newMember, outstanding, clock = Math.floor(Date.now() / 1000)) {
  if (!groupAddress(group) || !KEY.test(actor || '') || group.pubkey !== actor) {
    throw new Error('Solo il creatore verificato puo aggiungere partecipanti')
  }
  if (!KEY.test(newMember || '') || group.members?.includes(newMember)) {
    throw new Error('Chiave Nostr non valida o membro gia presente')
  }
  if (!Array.isArray(group.members) || group.members.length < 2 || group.members.length >= 100 ||
      !group.members.every(m => KEY.test(m)) || new Set(group.members).size !== group.members.length) {
    throw new Error('Numero o elenco dei partecipanti non valido')
  }
  if (group._consentPolicy !== 'signed-invites-v1' ||
      group._expensePolicy !== 'unanimous-expense-v1' ||
      group._revisionStatus !== 'verified' || group._financialReviewRequired ||
      group._expenseReviewRequired || group._inviteStatus !== 'accepted') {
    throw new Error('Gruppo non verificato o inviti non ancora accettati')
  }
  if (!group._financialHistoryChecked) {
    throw new Error('Storico finanziario non ancora sincronizzato: riprova dopo la verifica')
  }
  if (!Array.isArray(group._revisions) || !group._revisions.length ||
      group._revisions.length > 100 || !KEY.test(group._revisionId || '') ||
      group._revisions.at(-1).id !== group._revisionId ||
      group._revisions.at(-1).version !== group._revisions.length - 1) {
    throw new Error('Catena delle revisioni non verificata')
  }
  for (let i = 0; i < group._revisions.length; i++) {
    const rev = group._revisions[i]
    if (!Array.isArray(rev.members) || !rev.members.includes(actor) ||
        (i && rev.members.some(m => !group.members.includes(m))) ||
        (i && group._revisions[i - 1].members.some(m => !rev.members.includes(m)))) {
      throw new Error('Modifiche precedenti non supportate: riconciliazione richiesta')
    }
  }
  if (!Array.isArray(outstanding) || outstanding.length) {
    throw new Error('Outbox non vuota: recupera prima gli eventi firmati gia pendenti')
  }
  for (const key of ACTIVITY) {
    if (!Array.isArray(group[key]) || group[key].length) {
      throw new Error('Il gruppo contiene attivita finanziaria: modifica dei membri bloccata')
    }
  }
  // NIP-33 replaceable metadata must have a strictly later timestamp so an
  // unlucky same-second event-ID tie-break cannot resurrect the old roster.
  if (!Number.isSafeInteger(group._groupCreatedAt) ||
      !Number.isSafeInteger(clock) || clock <= group._groupCreatedAt) {
    throw new Error('Attendi il secondo successivo alla pubblicazione del gruppo')
  }
  return [...group.members, newMember]
}
