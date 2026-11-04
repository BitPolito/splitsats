import { test, expect } from '@playwright/test'
import { MemoryNostrRelay, openSignedClient, testSigner } from './relay-harness.js'

const login = async page => {
  await page.getByRole('button', { name: /CONNECT WALLET/ }).click()
  await expect(page.getByRole('button', { name: /NUOVO/ })).toBeVisible()
}

test('two signed cancellations unlock a disputed expense and preserve its audit trail', async ({ browser }) => {
  const relay = new MemoryNostrRelay()
  const owner = await openSignedClient(browser, relay, testSigner(71))
  const invited = await openSignedClient(browser, relay, testSigner(72))
  try {
    await login(owner.page)
    await login(invited.page)
    await owner.page.getByRole('button', { name: /NUOVO/ }).click()
    await owner.page.getByPlaceholder('es. Viaggio a Berlino').fill('Conciliazione 2C')
    await owner.page.getByPlaceholder(/hex pubkey/).fill(invited.pubkey)
    await owner.page.getByRole('button', { name: '+', exact: true }).click()
    await owner.page.getByRole('button', { name: 'CREATE GROUP' }).click()
    await invited.page.getByText('Conciliazione 2C', { exact: true }).click()
    await invited.page.getByRole('button', { name: 'ACCETTA INVITO' }).click()
    await owner.page.getByText('Conciliazione 2C', { exact: true }).click()
    await expect(owner.page.getByRole('button', { name: '+ ADD' })).toBeEnabled()
    await owner.page.getByRole('button', { name: '+ ADD' }).click()
    await owner.page.getByPlaceholder('es. Cena al ristorante').fill('Prima proposta contestata')
    await owner.page.getByPlaceholder('21000').fill('400')
    await owner.page.getByRole('button', { name: '⚡ ADD EXPENSE' }).click()
    await expect(invited.page.getByRole('button', { name: 'CONTESTA SPESA' })).toBeVisible()
    await invited.page.getByRole('button', { name: 'CONTESTA SPESA' }).click()
    await expect(owner.page.getByRole('button', { name: '+ ADD' })).toBeDisabled()
    await expect(owner.page.getByRole('button', { name: 'FIRMA ANNULLAMENTO' })).toBeVisible()
    owner.page.once('dialog', dialog => dialog.accept())
    await owner.page.getByRole('button', { name: 'FIRMA ANNULLAMENTO' }).click()
    await expect(owner.page.getByRole('button', { name: '+ ADD' })).toBeDisabled()
    invited.page.once('dialog', dialog => dialog.accept())
    await invited.page.getByRole('button', { name: 'FIRMA ANNULLAMENTO' }).click()
    await expect(invited.page.getByText('SPESA ANNULLATA CON CONSENSO')).toBeVisible()
    await expect(owner.page.getByRole('button', { name: '+ ADD' })).toBeEnabled()
    const signed = [...relay.events.values()]
    expect(signed.filter(e => e.kind === 9594)).toHaveLength(2)
    expect(signed.filter(e => e.kind === 9000)).toHaveLength(1)
    expect(signed.filter(e => e.kind === 9593 && JSON.parse(e.content).decision === 'dispute')).toHaveLength(1)

    // A corrected expense is a NEW proposal with its own approvals.
    await owner.page.getByRole('button', { name: '+ ADD' }).click()
    await owner.page.getByPlaceholder('es. Cena al ristorante').fill('Spesa corretta')
    await owner.page.getByPlaceholder('21000').fill('200')
    await owner.page.getByRole('button', { name: '⚡ ADD EXPENSE' }).click()
    await expect(invited.page.getByRole('button', { name: 'APPROVA SPESA' })).toBeVisible()
    await invited.page.getByRole('button', { name: 'APPROVA SPESA' }).click()
    await invited.page.getByRole('button', { name: 'SALDI' }).click()
    await expect(invited.page.getByText('DEVI').locator('..')).toContainText('100 sat')
    await invited.page.reload()
    await invited.page.getByText('Conciliazione 2C', { exact: true }).click()
    await expect(invited.page.getByText('SPESA ANNULLATA CON CONSENSO')).toBeVisible()
    await invited.page.getByRole('button', { name: 'SALDI' }).click()
    await expect(invited.page.getByText('DEVI').locator('..')).toContainText('100 sat')
  } finally {
    await Promise.allSettled([owner.context.close(), invited.context.close()])
  }
})
