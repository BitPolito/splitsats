import { test, expect } from '@playwright/test'
import { MemoryNostrRelay, openSignedClient, testSigner } from './relay-harness.js'

async function login(page) {
  await expect(page.getByRole('button', { name: /CONNECT WALLET/ })).toBeEnabled()
  await page.getByRole('button', { name: /CONNECT WALLET/ }).click()
  await expect(page.getByRole('button', { name: /NUOVO/ })).toBeVisible()
}

async function createGroup(page, name, memberPubkey) {
  await page.getByRole('button', { name: /NUOVO/ }).click()
  await expect(page.getByText('NEW GROUP')).toBeVisible()
  await page.getByPlaceholder('es. Viaggio a Berlino').fill(name)
  await page.getByPlaceholder(/hex pubkey/).fill(memberPubkey)
  await page.getByRole('button', { name: '+', exact: true }).click()
  await page.getByRole('button', { name: 'CREATE GROUP' }).click()
  await expect(page.getByText(name, { exact: true })).toBeVisible()
}

test('landing page requires a NIP-07 signer, no guest session', async ({ page }) => {
  const relay = new MemoryNostrRelay()
  await relay.attach(page.context())
  await page.goto('/')
  await expect(page.getByText('SPESE CONDIVISE · BITCOIN · NOSTR')).toBeVisible()
  await expect(page.getByRole('button', { name: /CONNECT WALLET/ })).toBeDisabled()
  await expect(page.getByText(/Installa.*Alby.*nos2x/)).toBeVisible()
})

test('invalid Nostr member is rejected in the real group creation form', async ({ browser }) => {
  const relay = new MemoryNostrRelay()
  const client = await openSignedClient(browser, relay, testSigner(9))
  try {
    await login(client.page)
    await client.page.getByRole('button', { name: /NUOVO/ }).click()
    await client.page.getByPlaceholder('es. Viaggio a Berlino').fill('Test invalid member')
    await client.page.getByPlaceholder(/hex pubkey/).fill('not-a-pubkey')
    await client.page.getByRole('button', { name: '+', exact: true }).click()
    await expect(client.page.getByText('NPUB O HEX NON VALIDO')).toBeVisible()
    await expect(client.page.getByRole('button', { name: 'CREATE GROUP' })).toBeDisabled()
    expect(relay.events.size).toBe(0)
  } finally {
    await client.context.close()
  }
})

test('two signed clients: group, expense, debtor claim, recipient approval, refresh', async ({ browser }) => {
  const relay = new MemoryNostrRelay()
  const a = await openSignedClient(browser, relay, testSigner(1))
  const b = await openSignedClient(browser, relay, testSigner(2))
  try {
    await login(a.page)
    await login(b.page)
    await createGroup(a.page, 'E2E viaggio', b.pubkey)
    await expect(b.page.getByText('E2E viaggio', { exact: true })).toBeVisible()

    await a.page.getByText('E2E viaggio', { exact: true }).click()
    await a.page.getByRole('button', { name: '+ ADD' }).click()
    await a.page.getByPlaceholder('es. Cena al ristorante').fill('Cena di prova')
    await a.page.getByPlaceholder('21000').fill('600')
    await a.page.getByRole('button', { name: '⚡ ADD EXPENSE' }).click()
    await expect(a.page.getByText('Cena di prova', { exact: true })).toBeVisible()

    await b.page.getByText('E2E viaggio', { exact: true }).click()
    await expect(b.page.getByText('Cena di prova', { exact: true })).toBeVisible()
    await b.page.getByRole('button', { name: 'SALDI' }).click()
    await expect(b.page.getByText('DEVI').locator('..')).toContainText('300 sat')
    await b.page.getByRole('button', { name: 'PAY ⚡' }).click()
    // Manual declaration is not proof of a Lightning payment. This test NEVER
    // invokes WebLN, QR, or a real wallet.
    await b.page.getByRole('button', { name: 'DICHIARA PAGAMENTO MANUALE' }).click()
    await expect(b.page.getByText(/RICHIESTA REGISTRATA/)).toBeVisible()

    await a.page.getByRole('button', { name: 'SALDI' }).click()
    await expect(a.page.getByRole('button', { name: 'CONFERMA RICEZIONE' })).toBeVisible()
    await expect(a.page.getByText('TI DEVONO').locator('..')).toContainText('300 sat')
    a.page.once('dialog', dialog => dialog.accept())
    await a.page.getByRole('button', { name: 'CONFERMA RICEZIONE' }).click()
    await expect(a.page.getByText('TUTTI IN PARI!')).toBeVisible()

    // A recipient-signed confirmation, not the payer's declaration, closes debt.
    await b.page.getByRole('button', { name: 'CHIUDI' }).click()
    await expect(b.page.getByText('TUTTI IN PARI!')).toBeVisible()

    await a.page.reload()
    await b.page.reload()
    await expect(a.page.getByText('E2E viaggio', { exact: true })).toBeVisible()
    await expect(b.page.getByText('E2E viaggio', { exact: true })).toBeVisible()
    await a.page.getByText('E2E viaggio', { exact: true }).click()
    await b.page.getByText('E2E viaggio', { exact: true }).click()
    await a.page.getByRole('button', { name: 'SALDI' }).click()
    await b.page.getByRole('button', { name: 'SALDI' }).click()
    await expect(a.page.getByText('TUTTI IN PARI!')).toBeVisible()
    await expect(b.page.getByText('TUTTI IN PARI!')).toBeVisible()
    expect([...relay.events.values()].filter(e => e.kind === 30001)).toHaveLength(1)
    expect([...relay.events.values()].filter(e => e.kind === 9000)).toHaveLength(1)
    expect([...relay.events.values()].filter(e => e.kind === 9001)).toHaveLength(1)
    expect([...relay.events.values()].filter(e => e.kind === 9002)).toHaveLength(1)
    const createdGroup = [...relay.events.values()].find(e => e.kind === 30001)
    const dTag = createdGroup.tags.find(t => t[0] === 'd')[1]
    const address = `30001:${createdGroup.pubkey}:${dTag}`
    for (const kind of [9000, 9001, 9002]) {
      const signed = [...relay.events.values()].find(e => e.kind === kind)
      expect(signed.tags).toContainEqual(['a', address])
    }
  } finally {
    await Promise.allSettled([a.context.close(), b.context.close()])
  }
})
