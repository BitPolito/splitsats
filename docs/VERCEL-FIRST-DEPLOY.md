# SplitSats — prima configurazione Vercel (account nuovo)

La creazione dell'account Vercel, le autorizzazioni GitHub e il primo deploy
**non** sono effettuati da questa patch. Non serve un account Vercel precedente.

## Preflight: sicurezza del branch di produzione

- GitHub ha `master` come branch predefinito; al 03/11/2026 `dev` era avanti di
  17 commit. Il vecchio `master` ha dipendenze e logiche antecedenti ai fix.
- **Non importare ancora `master` per un sito pubblico**. Prima completa i test
  E2E, controlla la pipeline, effettua smoke test con identità Nostr isolate,
  revisiona il diff `master...dev`, quindi promuovi `dev` in `master` con PR.
- Nessun `git reset --hard` o push forzato: preservare lo storico e il commit
  locale divergente non ancora revisionato.

## Account e importazione

1. Crea un **nuovo account** su https://vercel.com/signup e conferma email e
   autenticazione. Valuta un account/team dedicato al progetto.
2. Collega GitHub. Il repository è nell'organizzazione `BitPolito`; concedi a
   Vercel l'accesso a `BitPolito/splitsats`. Se non appare, controlla GitHub
   App installation e il tuo ruolo nell'organizzazione: potrebbe servire
   l'intervento dell'owner. Un semplice outside collaborator non basta per
   l'importazione di repository di organizzazione (secondo i docs Vercel).
3. **Dopo aver aggiornato `master` con i fix collaudati**, apri
   https://vercel.com/new e importa `BitPolito/splitsats`.
4. Impostazioni progetto: `Root Directory = ./`, `Framework Preset = Vite`,
   `Install Command = npm ci`, `Build Command = npm run build`,
   `Output Directory = dist`. Se disponibili, scegli Node.js 22.x in Project
   Settings > General > Node.js Version, coerente con GitHub Actions.
5. Non servono variabili d'ambiente obbligatorie per il codice attuale: il
   frontend usa signer NIP-07 e relay Nostr pubblici, e la funzione Node
   `api/lnurl.js` usa HTTPS server-side. **Non** aggiungere `nsec`, seed o
   token privati a `VITE_*`: Vite espone quelle variabili nel bundle client.
6. Conferma `master` come Production Branch nelle impostazioni di Vercel.
   `dev` e le feature branches possono generare deployment di **Preview**.
7. Verifica che le rewrite di `vercel.json` preservino `/api/lnurl` e che la
   SPA carichi `index.html` anche ricaricando un URL interno.

## Smoke test sul nuovo URL Vercel (senza satoshi)

- [ ] Pagina iniziale visibile su HTTPS, asset JS/CSS senza 404.
- [ ] Senza estensione NIP-07 il login è disabilitato, con messaggio esplicativo.
- [ ] `GET /api/lnurl?address=bad` risponde JSON e status 400 (input invalido).
- [ ] `POST /api/lnurl?address=bad` non consente di usare il proxy come API generica (405).
- [ ] Le risposte API hanno `Cache-Control: no-store` e
      `X-Content-Type-Options: nosniff`.
- [ ] In due profili browser separati e con estensioni NIP-07 differenti,
      login e creazione gruppo funzionano con relay reali.
- [ ] Creazione spesa, richiesta **manuale** e conferma firmata ricostruiscono
      i saldi dopo refresh. NON affermare che una dichiarazione manuale
      corrisponda a un pagamento Lightning effettivamente ricevuto.
- [ ] Simula almeno una connessione relay interrotta: non duplicare l'evento
      originale, usa `RIPROVA OUTBOX` per l'ID firmato esistente.
- [ ] Non inviare fondi reali prima di revisionare/validare manualmente il
      percorso LNURL/WebLN su wallet indipendenti e importi minimi.

## Pre-release checklist

```bash
npm ci
npm test
npm run test:e2e
npm run build
npm audit
npm audit --omit=dev
```

La pipeline E2E usa relay WebSocket **simulati** e firme Nostr reali ma chiavi
esclusivamente di test. Conferma browser e reti REALI non sono coperti dagli
E2E automatizzati.

Riferimenti ufficiali:
- https://vercel.com/docs/git
- https://vercel.com/docs/git/vercel-for-github
- https://vercel.com/docs/environment-variables
- https://vercel.com/docs/projects/managing-projects
