import { test, expect } from '@playwright/test'
import { MemoryNostrRelay, openSignedClient, testSigner } from './relay-harness.js'

async function login(page) {
  await expect(page.getByRole('button', { name: /CONNECT WALLET/ })).toBeEnabled()
  await page.getByRole('button', { name: /CONNECT WALLET/ }).click()
  await expect(page.getByRole('button', { name: /NUOVO/ })).toBeVisible()
}

async function makeGroup(page, name, member) {
  await page.getByRole('button', { name: /NUOVO/ }).click()
  await page.getByPlaceholder('es. Viaggio a Berlino').fill(name)
  await page.getByPlaceholder(/hex pubkey/).fill(member)
  await page.getByRole('button', { name: '+', exact: true }).click()
  await page.getByRole('button', { name: 'CREATE GROUP' }).click()
  await expect(page.getByText(name, { exact: true })).toBeVisible()
}

test('a new member needs a signed owner revision and renewed opt-in; historical heads survive refresh', async ({ browser }) => {
  const relay = new MemoryNostrRelay()
  const a = await openSignedClient(browser, relay, testSigner(71))
  const b = await openSignedClient(browser, relay, testSigner(72))
  const c = await openSignedClient(browser, relay, testSigner(73))
  try {
    await Promise.all([login(a.page), login(b.page), login(c.page)])
    await makeGroup(a.page, 'Nuovo partecipante', b.pubkey)
    await b.page.getByText('Nuovo partecipante', { exact: true }).click()
    await b.page.getByRole('button', { name: 'ACCETTA INVITO' }).click()
    await a.page.getByText('Nuovo partecipante', { exact: true }).click()
    await a.page.getByRole('button', { name: 'MEMBRI' }).click()
    await a.page.getByRole('textbox', { name: 'Nuovo membro Nostr' }).fill(c.pubkey)
    // NIP-33 metadata must have a strictly newer second than the old head.
    await a.page.waitForTimeout(1250)
    await expect(a.page.getByRole('button', { name: 'AGGIUNGI MEMBRO' })).toBeEnabled()
    await a.page.getByRole('button', { name: 'AGGIUNGI MEMBRO' }).click()
    await expect(c.page.getByText('Nuovo partecipante', { exact: true })).toBeVisible()
    await c.page.getByText('Nuovo partecipante', { exact: true }).click()
    await expect(b.page.getByRole('button', { name: 'ACCETTA INVITO' })).toBeVisible()
    await expect(c.page.getByRole('button', { name: 'ACCETTA INVITO' })).toBeVisible()
    await b.page.getByRole('button', { name: 'ACCETTA INVITO' }).click()
    await c.page.getByRole('button', { name: 'ACCETTA INVITO' }).click()
    await a.page.getByRole('button', { name: 'SPESE' }).click()
    await expect(a.page.getByRole('button', { name: '+ ADD' })).toBeEnabled()
    await Promise.all([a.page.reload(), b.page.reload(), c.page.reload()])
    await a.page.getByText('Nuovo partecipante', { exact: true }).click()
    await a.page.getByRole('button', { name: 'MEMBRI' }).click()
    const definitions = [...relay.events.values()].filter(e => e.kind === 30001)
    expect(JSON.parse(definitions.at(-1).content).members).toContain(c.pubkey)
    expect([...relay.events.values()].filter(e => e.kind === 9591)).toHaveLength(2)
    expect([...relay.events.values()].filter(e => e.kind === 30001)).toHaveLength(2)
    expect([...relay.events.values()].filter(e => e.kind === 9592)).toHaveLength(3)
    expect([...relay.events.values()].filter(e => e.kind === 9000)).toHaveLength(0)
  } finally {
    await Promise.allSettled([a.context.close(), b.context.close(), c.context.close()])
  }
})
