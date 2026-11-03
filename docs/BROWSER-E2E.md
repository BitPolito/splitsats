# SplitSats — browser end-to-end tests

Questi test avviano Vite con Playwright e **Chromium reale**, poi usano la UI
React esistente. La differenza rispetto agli unit test e' che vengono attraversate
le interazioni del browser e due vere sessioni isolate, con storage indipendente.

## Isolamento e attendibilita'

- Signer NIP-07 simulato **solo nel browser di test**. Ogni evento e' firmato
  via `nostr-tools.finalizeEvent` nel runner Node con test keys deterministiche;
  i client verificano gli eventi tramite `verifyEvent`, come in produzione.
- Relay WebSocket simulato in memoria tramite `routeWebSocket` di Playwright:
  gestisce REQ, EVENT, OK, EOSE, CLOSE, filtro per kind/autore/tag e replay.
  Nessuna connessione a relay pubblici e nessuna chiamata a wallet reali.
- Il flusso esamina: login senza signer; input pubkey invalido; due identita',
  gruppo con due membri, spesa, saldo, dichiarazione MANUALE del debitore,
  conferma firmata del creditore, refresh e ricostruzione saldi. La conferma
  manuale nel test NON prova che un wallet abbia davvero ricevuto satoshi.
- I test non sostituiscono test su NIP-07 reale, browser mobile, WebLN o
  condizioni reali del network.

## Comandi

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
npm run test:e2e
npm run test:e2e:ui
```

In Linux/CI il browser necessita delle dipendenze di sistema. La pipeline
installa con `npx playwright install --with-deps chromium`.

## Troubleshooting

- Se `4173` e' gia' occupata, chiudi il processo Vite locale; in CI si usa
  sempre il webServer dedicato e non si riutilizza un processo precedente.
- Se i test falliscono solo in CI, controlla i trace in `playwright-report`.
- Non registrare chiavi private, seed phrase o indirizzi reali nei fixture.
- `npm test` rimane dedicato agli unit/integration test Node; i file Playwright
  hanno estensione `.spec.js` dentro `e2e/` e si eseguono separatamente.

API di riferimento: https://playwright.dev/docs/test-webserver
