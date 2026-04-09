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
│   ├── nostr.js         # RelayPool, publishEvent, fetch helpers
│   ├── lightning.js     # WebLN, LNURL-pay
│   ├── balances.js      # Calcolo e semplificazione debiti
│   ├── storage.js       # localStorage cache
│   └── constants.js     # Relay list, event kinds
├── views/               # Schermate principali
└── components/          # UI primitives + modals
```

## Nostr event kinds usati

| Kind  | Uso                        |
|-------|----------------------------|
| 0     | Profilo utente (NIP-01)    |
| 9000  | Spesa                      |
| 9001  | Pagamento / settlement     |
| 30001 | Definizione gruppo         |
