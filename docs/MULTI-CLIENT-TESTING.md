# SplitSats — test di integrazione multi-client

## Test automatici senza servizi esterni

Da una checkout con dipendenze installate:

```bash
npm ci
npm test
npm run build
npm audit --omit=dev
```

`tests/two-client-relay.integration.test.js` usa il trasporto `RelayPool` reale,
parser degli eventi, calcolo dei saldi e outbox persistente, collegando due
client indipendenti a un relay **in memoria**. Non richiede browser, estensioni,
server Nostr o fondi Lightning.

Casi coperti:

1. Entrambi i client ricevono lo stesso gruppo e la stessa spesa senza contarla due volte, anche con replay del relay.
2. Un evento `kind:9001` inviato dal debitore, anche con `walletReported`, non riduce i saldi. Solo il `kind:9002` del destinatario li aggiorna; una conferma di un estraneo è scartata.
3. Un timeout del relay seguito da refresh conserva l'evento firmato nell'outbox. Il retry usa l'**ID originale** e non duplica i debiti dell'altro client.
4. Un secondo dispositivo ricostruisce da zero il saldo e le conferme dopo aver letto lo storico del relay.

**Limiti:** le firme in questi test sono marcatori simulati (non Schnorr), le
risposte del relay sono simulate, non viene eseguita la UI React, e nessun
pagamento reale viene effettuato. Non presentare il superamento di questi test
come prova di sicurezza finanziaria end-to-end.

## Checklist manuale con due account Nostr distinti

Utilizza due profili browser separati (o due dispositivi), con estensioni NIP-07
e account Nostr distinti. Usa wallet di test e importi minimi, non fondi di valore.
Non usare lo stesso account in entrambi i profili per simulare due persone.

- [ ] Avvia `npm run dev` su localhost e apri l'app con il profilo A; connetti il signer e controlla la pubkey visualizzata.
- [ ] Apri l'app col profilo B, autorizza l'altro signer e verifica che non compaiano gruppi privati/cached di A prima della sincronizzazione.
- [ ] Da A crea un gruppo con A e B; controlla che B lo riceva dopo la sincronizzazione con i relay.
- [ ] Da A registra una spesa di 600 sat divisa equamente; entrambi devono vedere A creditore di 300 e B debitore di 300.
- [ ] B dichiara un pagamento di 300 sat: il saldo NON deve cambiare finché A non lo conferma.
- [ ] A controlla nel proprio wallet l'effettivo accredito **prima** di firmare la conferma. Se non risulta ricevuto, non confermare.
- [ ] Dopo conferma firmata da A, i saldi su entrambi i profili tornano a zero.
- [ ] Disconnetti temporaneamente il relay durante la pubblicazione di una nuova spesa; al timeout verifica l'evento in outbox e usa RIPROVA OUTBOX dopo riconnessione. Non firmare una spesa duplicata.
- [ ] Ricarica entrambe le pagine e verifica che il gruppo, i saldi e le conferme coincidano. Cambia signer sul profilo A e verifica che non vengano mostrati dati dell'account precedente.
- [ ] Prova un'eventuale invoice QR senza pagarla: non deve essere considerata un pagamento confermato.

Annota nel report finale la data, le versioni dei browser, il wallet,
i relay usati, gli ID Nostr degli eventi di prova (non chiavi private!), e ogni
anomalia. Non condividere `nsec`, seed phrase, preimage o altri segreti.

## Verifiche CI

La pipeline esegue `npm audit --omit=dev --audit-level=moderate` per bloccare
nuove vulnerabilità moderate o più gravi nelle dipendenze di produzione.
Le dipendenze di sviluppo vanno comunque controllate periodicamente con
`npm audit`, soprattutto quando si avvia il server Vite su reti non fidate.
L'aggiornamento di Vite è gestito separatamente nella PR di sicurezza.
