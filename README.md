# SplitSats ⚡₿

Spese condivise su Nostr. Pagamenti in Bitcoin. Zero server.

## Stack

- **Auth** — Nostr NIP-07 (Alby / nos2x)
- **Dati** — Relay Nostr pubblici (kind:9000, kind:30001)
- **Pagamenti** — Bitcoin Lightning via WebLN + LNURL-pay
- **Frontend** — React + Vite
- **State** — Zustand + localStorage (cache)

## Setup locale

```bash
npm install
npm run dev
```

Per verificare le regole dei saldi prima di una PR:

```bash
npm test
npm run build
```

Apri `http://localhost:5173` con l'estensione **Alby** installata.

## Deploy su Vercel

```bash
npm run build
vercel --prod
```

Oppure connetti il repo su vercel.com → deploy automatico ad ogni push.

## Struttura

```
src/
├── App.jsx              # Root + routing
├── store/index.js       # Zustand store (auth, groups, expenses)
├── lib/
│   ├── nostr.js         # publishEvent, Nostr subscriptions
│   ├── relay-pool.js    # NIP-20 ACK, retry on reconnect, subscriptions
│   ├── lightning.js     # WebLN, LNURL-pay
│   ├── balances.js      # Calcolo e semplificazione debiti
│   ├── storage.js       # localStorage cache
│   └── constants.js     # Relay list, event kinds
├── views/               # Schermate principali
└── components/          # UI primitives + modals
```

## Conferma pagamenti

Le richieste di pagamento (anche WebLN) rimangono **in attesa** finché il destinatario non firma una conferma Nostr. Una risposta WebLN da sola non prova la ricezione. I vecchi pagamenti non confermati non vengono più sottratti ai saldi: verifica la migrazione prima del deploy. Dettagli: [docs/PAYMENT-CONFIRMATION.md](docs/PAYMENT-CONFIRMATION.md).

## Affidabilità della pubblicazione

La pubblicazione degli eventi attende un ACK `OK` da almeno un relay Nostr. In assenza di ACK entro 12 secondi l'esito è **incerto**, quindi bisogna controllare il gruppo prima di riprovare. Non inviare nuovamente satoshi solo perché la pubblicazione su Nostr non è stata confermata. Dettagli: [docs/RELAY-PUBLICATION.md](docs/RELAY-PUBLICATION.md).

## Nostr event kinds usati

| Kind  | Uso                        |
|-------|----------------------------|
| 0     | Profilo utente (NIP-01)    |
| 9000  | Spesa                      |
| 9001  | Dichiarazione di pagamento (in attesa) |
| 9002  | Conferma del destinatario |
| 30001 | Definizione gruppo         |

## Recupero eventi pubblicati con esito incerto

Le nuove spese, i gruppi e le dichiarazioni/conferme di pagamento vengono
salvati come eventi Nostr **già firmati** nell'outbox locale prima della
pubblicazione. Se nessun relay conferma la ricezione, apri **OUTBOX NOSTR →
RIPROVA OUTBOX** per reinviare lo stesso evento senza duplicarlo e senza
ripetere il pagamento Lightning. Consulta [docs/NOSTR-OUTBOX.md](docs/NOSTR-OUTBOX.md).

## Cache per account e sicurezza delle dipendenze

La cache gruppi/profili ora è isolata per chiave Nostr e il ripristino della
sessione richiede un signer corrispondente. Vedi [cache account](docs/ACCOUNT-CACHE-SECURITY.md).
L'audit delle dipendenze npm e le istruzioni per gli aggiornamenti sicuri sono
in [docs/DEPENDENCY-AUDIT.md](docs/DEPENDENCY-AUDIT.md).
