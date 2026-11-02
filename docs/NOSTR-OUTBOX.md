# Outbox persistente Nostr (Fase 6)

## Problema risolto

Un evento `EVENT` inviato via WebSocket non equivale a un ACK NIP-20. Dopo
12 secondi senza ACK, il trasporto segnala `RELAY_PUBLICATION_UNKNOWN`: almeno
un relay *potrebbe* avere ricevuto l'evento. Firmarne uno nuovo (con ID diverso)
può creare una seconda spesa o una seconda richiesta di pagamento.

## Comportamento

1. Il signer NIP-07 firma l'evento. SplitSats verifica la firma e salva **l'intero
   evento firmato** in `localStorage`, nella chiave `splitsats:outbox:v1:<pubkey>`.
2. **Solo dopo la scrittura riuscita** il client invia l'evento ai relay.
3. Un ACK positivo da almeno un relay rimuove l'evento dalla coda. Un timeout
   o un rifiuto non cancella nulla; l'esito rimane incerto.
4. Un banner `OUTBOX NOSTR` mostra gli ID degli eventi pendenti. **RIPROVA OUTBOX**
   verifica che la chiave dell'estensione NIP-07 sia uguale alla chiave della
   sessione, controlla le firme e ripubblica i **medesimi eventi firmati**;
   non rigenera ID, non richiama un wallet e non firma di nuovo.
5. Se esiste un evento da recuperare, l'app blocca la creazione di un nuovo
   evento dello stesso tipo nello stesso gruppo. Creazioni gruppo in sospeso
   bloccano altre nuove creazioni gruppo finché la sincronizzazione non riesce.
6. Le code sono distinte per account e **non vengono eliminate al logout**:
   questa scelta preserva gli eventi incerti, ma lascia sul dispositivo i
   contenuti pubblici già firmati. Usare un profilo browser dedicato se il
   dispositivo è condiviso.
7. Se l'archiviazione locale è indisponibile, piena o danneggiata, si interrompe
   la pubblicazione e **non si invia l'evento**. Non si sovrascrivono dati corrotti.

## Cosa non significa

- Un ACK conferma l'accettazione da parte di un relay, non la conservazione
  permanente o la sincronizzazione di tutti i client.
- La conferma firmata dal destinatario è una conferma applicativa, non una prova
  crittografica del pagamento Lightning.
- `localStorage` non è sincronizzato tra dispositivi, non è un backup sicuro e
  non garantisce scritture atomiche tra più tab contemporaneamente.
- L'outbox serve alla pubblicazione di eventi, **mai** a ripetere pagamenti:
  verificare la cronologia del wallet prima di fare qualunque nuovo invio.
- Non eliminare le chiavi locali del browser né usare incautamente `Clear site
  data` mentre ci sono eventi in sospeso.

## Test

`npm test` esegue casi su riavvio della coda, isolamento degli account,
corruzione e quota, prevenzione dei duplicati, firma non valida, timeout,
conferma ACK e retry senza re-firma. `npm run build` verifica la compilazione UI.

## Limitazioni e prossimi passi

- Implementare uno storico dei tentativi e un recupero assistito dopo rifiuti
  persistenti dei relay, con diagnostica per singolo relay.
- Test browser multi-tab e multi-device, con due estensioni signer e relay reali.
- Aggiungere eventuale approccio IndexedDB se la coda supera i limiti di
  `localStorage`, con gestione di transazioni tra tab.
