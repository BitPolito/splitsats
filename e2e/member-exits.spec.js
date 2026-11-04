import { test, expect } from '@playwright/test'
import { MemoryNostrRelay, openSignedClient, testSigner } from './relay-harness.js'

async function login(page) {
  await expect(page.getByRole('button', { name: /CONNECT WALLET/ })).toBeEnabled()
  await page.getByRole('button', { name: /CONNECT WALLET/ }).click()
  await expect(page.getByRole('button', { name: /NUOVO/ })).toBeVisible()
}

test('voluntary exit requires a member signature, owner revision, and fresh consent from remaining member', async ({ browser }) => {
  const relay = new MemoryNostrRelay()
  const a = await openSignedClient(browser, relay, testSigner(81))
  const b = await openSignedClient(browser, relay, testSigner(82))
  const c = await openSignedClient(browser, relay, testSigner(83))
  try {
    await Promise.all([login(a.page), login(b.page), login(c.page)])
    await a.page.getByRole('button', { name: /NUOVO/ }).click()
    await a.page.getByPlaceholder('es. Viaggio a Berlino').fill('Uscita firmata')
    for (const key of [b.pubkey, c.pubkey]) {
      await a.page.getByPlaceholder(/hex pubkey/).fill(key)
      await a.page.getByRole('button', { name: '+', exact: true }).click()
    }
    await a.page.getByRole('button', { name: 'CREATE GROUP' }).click()
    await expect(a.page.getByText('Uscita firmata', { exact: true })).toBeVisible()
    await b.page.getByText('Uscita firmata', { exact: true }).click()
    await c.page.getByText('Uscita firmata', { exact: true }).click()
    await b.page.getByRole('button', { name: 'ACCETTA INVITO' }).click()
    await c.page.getByRole('button', { name: 'ACCETTA INVITO' }).click()
    await a.page.getByText('Uscita firmata', { exact: true }).click()
    await b.page.getByRole('button', { name: 'MEMBRI' }).click()
    await a.page.getByRole('button', { name: 'MEMBRI' }).click()
    // Guard against same-second replaceable metadata and signed request timestamps.
    await b.page.waitForTimeout(1250)
    await expect(b.page.getByRole('button', { name: 'RICHIEDI USCITA' })).toBeEnabled()
    await b.page.getByRole('button', { name: 'RICHIEDI USCITA' }).click()
    await expect(b.page.getByText(/RICHIESTA USCITA INVIATA/)).toBeVisible()
    await expect(a.page.getByRole('button', { name: 'CONFERMA USCITA' })).toBeVisible()
    // Request itself must not remove the member or unlock a fresh definition.
    expect([...relay.events.values()].filter(e => e.kind === 30001)).toHaveLength(1)
    await a.page.waitForTimeout(1250)
    await a.page.getByRole('button', { name: 'CONFERMA USCITA' }).click()
    await expect(c.page.getByRole('button', { name: 'ACCETTA INVITO' })).toBeVisible()
    await c.page.getByRole('button', { name: 'ACCETTA INVITO' }).click()
    await a.page.getByRole('button', { name: 'SPESE' }).click()
    await expect(a.page.getByRole('button', { name: '+ ADD' })).toBeEnabled()
    const revisions = [...relay.events.values()].filter(e => e.kind === 9591)
    const proofs = [...relay.events.values()].filter(e => e.kind === 9595)
    const definitions = [...relay.events.values()].filter(e => e.kind === 30001)
    expect(revisions).toHaveLength(2)
    expect(proofs).toHaveLength(1)
    expect(proofs[0].pubkey).toBe(b.pubkey)
    expect(definitions).toHaveLength(2)
    expect(JSON.parse(definitions.at(-1).content).members).not.toContain(b.pubkey)
    const content = JSON.parse(revisions.at(-1).content)
    expect(content.exitProofEventId).toBe(proofs[0].id)
    expect(content.exitedMember).toBe(b.pubkey)
    await a.page.reload()
    await expect(a.page.getByText('Uscita firmata', { exact: true })).toBeVisible()
    await a.page.getByText('Uscita firmata', { exact: true }).click()
    await expect(a.page.getByRole('button', { name: '+ ADD' })).toBeEnabled()
  } finally {
    await Promise.allSettled([a.context.close(), b.context.close(), c.context.close()])
  }
})
