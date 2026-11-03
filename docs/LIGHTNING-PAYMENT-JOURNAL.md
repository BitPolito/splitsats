# Fase 10 — Registro locale dei tentativi WebLN

## Obiettivo

Un errore o timeout di `webln.sendPayment` **non prova** che Lightning non abbia
inviato satoshi. Un refresh, la chiusura del modal o un cambio di pagina non
devono offrire all'utente un nuovo pagamento automatico per lo stesso debito.

## Protocollo implementato

1. Recupero metadata/invoice LNURL e verifica che il signer NIP-07 sia ancora
   quello dell'account debitore.
2. **Prima** della chiamata `webln.sendPayment`, scrittura sincronizzata del
   tentativo in `localStorage`, con chiave per `(account, groupId, payee)`.
   Se lo storage è indisponibile, corrotto o non verificabile, si blocca il
   pagamento *prima* di passare l'invoice al wallet.
3. `submitted`: l'invoice è stata consegnata o sta per essere consegnata al
   wallet. Non è prova di pagamento.
4. `outcome-unknown`: timeout, errore o risposta WebLN senza preimage valida.
   Non si ritenta il pagamento automaticamente.
5. `wallet-reported`: il wallet ha riferito un pagamento, ma non c'è ancora
   conferma del destinatario. La risposta WebLN non è prova indipendente.
6. `claim-pending`: dichiarazione Nostr firmata con `kind:9001`, accettata da
   almeno un relay. Il debito resta aperto fino al `kind:9002` del destinatario.
7. Il blocco viene cancellato **soltanto** dopo una conferma del destinatario
   verificata dal relay che faccia riferimento all'ID preciso della dichiarazione,
   o dopo l'esplicita procedura di recupero per un pagamento *non effettuato*.

Gli stati vengono recuperati dopo refresh. Nessun dato sensibile del wallet
(preimage, invoice, segreti) è persistito nel registro; si salvano solo
account, gruppo, destinatario, importo, timestamp, stato e ID evento Nostr.

Quando il browser supporta Web Locks, le operazioni sono serializzate fra tab
della stessa origine. Negli altri browser è utilizzata una guardia `localStorage`
best effort: non è una transazione atomica fra tab.

## Wallet esterno / QR

Prima di rendere visibile il QR, l'app recupera la invoice, ricontrolla il signer
Nostr e persiste un tentativo con lo **stesso blocco debitore/gruppo/destinatario**
usato da WebLN. Se lo storage non è scrivibile, il QR non viene mostrato. Un
refresh, una seconda tab o il passaggio da QR a WebLN non devono consentire un
nuovo pagamento finché l'esito non è chiarito. La fattura e la preimage non
vengono scritte nel registro. Un wallet esterno resta non osservabile: l'utente
deve controllare la cronologia e ottenere la conferma del destinatario.

## Recupero guidato

- **Pagamento eseguito, dichiarazione mancante:** verificare la cronologia del
  wallet e chiedere al destinatario. Se non esiste una dichiarazione Nostr già
  nell'outbox, usare l'opzione per registrare la richiesta **senza ripagare**.
- **Pagamento non eseguito:** verificare sia con il wallet sia con il
  destinatario; solo allora sbloccare il tentativo inserendo la conferma
  `NESSUN PAGAMENTO`. Una dichiarazione Nostr già pubblicata e in attesa
  della conferma non può essere cancellata con questa procedura.
- **Outbox in attesa:** recuperare e ripubblicare l'evento già firmato con
  `RIPROVA OUTBOX`; non creare una nuova dichiarazione.

## Test

`npm test` include i nuovi casi per persistenza fra refresh, isolamento per
account/beneficiario, importo che cambia, write failure, storage corrotto,
blocco del secondo pagamento, preimage/invoice non persistite, rilascio solo
con conferma esatta e Web Locks.

## Limiti prima di utilizzare fondi reali

- `localStorage` è locale al browser. Modalità privata, pulizia dati, browser o
  dispositivi differenti possono perdere il blocco. Non esiste ancora una
  coordinazione transazionale remota dei wallet, quindi non è prevenuto ogni
  possibile doppio pagamento **tra dispositivi**.
- La presenza di una preimage esadecimale valida per formato **non** prova da
  sola che corrisponda alla payment hash della invoice: servono parsing BOLT11,
  verifica di hash/importo/destinazione/scadenza e test con wallet reali.
- Conferma Nostr del destinatario significa attestazione di ricezione, **non**
  verifica indipendente del network Lightning.
- Il flusso QR ora riserva un tentativo persistente **prima** di mostrare/copiare la fattura. Non può però stabilire se un wallet esterno l'abbia pagata: non si sblocca automaticamente e il recupero richiede la verifica di wallet e destinatario. Un QR abbandonato può quindi richiedere uno sblocco manuale esplicito.
- La cache dei gruppi può essere precedente alla sincronizzazione: il blocco
  viene rilasciato automaticamente solo dopo un **nuovo evento firmato ricevuto
  e verificato** dal relay, non sulla base della cache locale.

Prima del rilascio: test reale con due wallet e due account Nostr indipendenti,
relay pubblici/offline, reti instabili, verifica degli importi e deploy Vercel.
