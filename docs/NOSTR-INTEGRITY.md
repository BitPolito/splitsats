# SplitSats — integrità degli eventi Nostr

Questa revisione è applicata **sopra** la prima correzione dei saldi e la patch di sicurezza LNURL.

## Modello di autorizzazione implementato

La firma Nostr continua a essere verificata con `verifyEvent` nel `RelayPool`. I nuovi parser puri in `src/lib/event-validation.js` applicano poi controlli di **autorizzazione applicativa** prima di inserire eventi nei saldi:

- `kind:30001` (gruppo): autore membro del gruppo, utente corrente nella lista dei membri, tag `p` coerenti con la lista, `d` coerente con l'eventuale `id` nel contenuto, nessun duplicato/chiave malformata. Il gruppo è associato all'autore e aggiornato soltanto da eventi successivi dello stesso autore. Gli aggiornamenti replaceable vengono ordinati per timestamp Nostr e, in caso di parità, per event ID. Una nuova lista membri provoca la risottoscrizione a spese/settlement.
- `kind:9000` (spesa): firmatario membro del gruppo, `g` tag corrispondente al gruppo, importo intero positivo, pagante e partecipanti membri validi, ID e descrizione validi, split non vuoto e senza duplicati. Un membro può ancora registrare una spesa pagata da un altro membro, secondo la semantica collaborativa attuale.
- `kind:9001` (regolamento): `event.pubkey === from`, `from` e `to` membri distinti, `g` e `p` tag corretti e importo intero positivo. I regolamenti più vecchi senza `id` applicativo continuano a essere accettati utilizzando l'ID dell'evento.
- Il signer NIP-07 deve restituire un evento autentico, con autore, kind, contenuto e tag identici a quelli richiesti. In caso contrario la pubblicazione viene rifiutata.
- Gli ID generati per i nuovi gruppi/spese/settlement ora usano `crypto.randomUUID()`; gli ID preesistenti restano utilizzabili.

## Test

`npm test` esegue, tra gli altri, 15 casi per gruppi, spese e regolamenti non autorizzati, payload invalidi, aggiornamenti fuori ordine e compatibilità legacy.

## Limiti importanti / decisioni di prodotto aperte

1. **Un membro può mentire su una spesa** in qualità di autore e indicare un altro membro come pagante: la firma dimostra chi *ha pubblicato* l'evento, non che la spesa sia realmente avvenuta. Servono consenso del pagante o flusso di approvazione se il progetto deve resistere a membri malintenzionati.
2. **Un regolamento non è una prova del pagamento Lightning.** Un debitore può firmare un evento di pagamento senza aver effettivamente pagato; servono verifiche indipendenti o conferma del creditore.
3. **Un invito non implica accettazione.** Chiunque può pubblicare un gruppo valido che include la chiave di un altro utente; un flusso accept/reject per inviti va progettato separatamente.
4. **Collisioni legacy:** l'UI usa ancora l'ID `d` come identificatore del gruppo. Due autori diversi che pubblicano lo stesso `d` non possono coesistere localmente: il primo viene mantenuto e l'altro ignorato. Sarebbe opportuno usare internamente `(pubkey, d)` in una successiva migrazione.
5. **Membership nel tempo:** i controlli usano la lista attuale dei membri, quindi eventi storici di membri poi rimossi non sono più importati. Un modello con versioni temporali della membership richiede specifiche e test ulteriori.
6. **Cache pregressa:** questa patch valida gli *eventi nuovi letti dal relay*, ma non garantisce l'integrità crittografica dei dati già persistiti in `localStorage` dalle versioni precedenti. La cache resta ottimistica/offline e richiede una riconciliazione verificata con il relay prima dell'uso finanziario.
7. **Disponibilità e finalità:** il delivery relay è best effort, non confermato con ACK; le sottoscrizioni e gli EOSE in presenza di relay intermittenti richiedono ulteriori verifiche. Non effettuare pagamenti reali basandoti solo sul saldo mostrato.
8. **Nessun test end-to-end** con signer reale, relay multipli e provider Lightning reali è incluso. Verificare sul Mac con `npm ci && npm test && npm run build` e un test manuale multi-account.

## Prossimi interventi

- Schema autore-scoped per gruppi + accettazione inviti + riconciliazione della cache.
- Gestione robusta di EOSE/ACK/reconnect, osservabilità degli errori pubblicazione.
- Stati `pending`, `paid`, `recorded` con verifica pagamento Lightning indipendente dal firmatario.
- Audit dipendenze npm e verifica del deployment.
