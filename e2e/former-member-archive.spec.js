import { test, expect } from '@playwright/test'
import { MemoryNostrRelay, openSignedClient, testSigner } from './relay-harness.js'

async function login(page) {
  await page.getByRole('button', { name: /CONNECT WALLET/ }).click()
  await expect(page.getByRole('button', { name: /NUOVO/ })).toBeVisible()
}

test('signed former member can inspect a separate, nonpayable audit archive', async ({ browser }) => {
  const relay = new MemoryNostrRelay()
  const a = await openSignedClient(browser, relay, testSigner(101))
  const b = await openSignedClient(browser, relay, testSigner(102))
  const c = await openSignedClient(browser, relay, testSigner(103))
  try {
    await Promise.all([login(a.page), login(b.page), login(c.page)])
    await a.page.getByRole('button', { name: /NUOVO/ }).click()
    await a.page.getByPlaceholder('es. Viaggio a Berlino').fill('Archivio ex membro')
    for (const member of [b.pubkey, c.pubkey]) {
      await a.page.getByPlaceholder(/hex pubkey/).fill(member)
      await a.page.getByRole('button', { name: '+', exact: true }).click()
    }
    await a.page.getByRole('button', { name: 'CREATE GROUP' }).click()
    await b.page.getByText('Archivio ex membro', { exact: true }).click()
    await c.page.getByText('Archivio ex membro', { exact: true }).click()
    await b.page.getByRole('button', { name: 'ACCETTA INVITO' }).click()
    await c.page.getByRole('button', { name: 'ACCETTA INVITO' }).click()
    await a.page.getByText('Archivio ex membro', { exact: true }).click()
    await b.page.getByRole('button', { name: 'MEMBRI' }).click()
    await a.page.getByRole('button', { name: 'MEMBRI' }).click()
    await b.page.waitForTimeout(1250)
    await b.page.getByRole('button', { name: 'RICHIEDI USCITA' }).click()
    await expect(a.page.getByRole('button', { name: 'CONFERMA USCITA' })).toBeVisible()
    await a.page.waitForTimeout(1250)
    await a.page.getByRole('button', { name: 'CONFERMA USCITA' }).click()
    await expect(c.page.getByRole('button', { name: 'ACCETTA INVITO' })).toBeVisible()
    await c.page.getByRole('button', { name: 'ACCETTA INVITO' }).click()

    // Signed exit proves a historical role; it cannot resurrect active access.
    await b.page.getByRole('button', { name: /BACK/ }).click()
    await b.page.getByRole('button', { name: 'ARCHIVIO' }).click()
    await expect(b.page.getByText('ARCHIVIO EX MEMBRI')).toBeVisible()
    await b.page.getByRole('button', { name: /GRUPPO.* · / }).click()
    await expect(b.page.getByText('ACCESSO ARCHIVIO VERIFICATO — SOLA LETTURA')).toBeVisible()
    await expect(b.page.getByText(/Snapshot non attestabile/)).toBeVisible()
    await expect(b.page.getByRole('button', { name: '+ ADD' })).toHaveCount(0)
    await expect(b.page.getByRole('button', { name: 'ATTESTA QUESTO SNAPSHOT' })).toHaveCount(0)
    expect([...relay.events.values()].filter(e => e.kind === 9596)).toHaveLength(0)
  } finally {
    await Promise.allSettled([a.context.close(), b.context.close(), c.context.close()])
  }
})
