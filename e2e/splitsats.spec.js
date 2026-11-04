import { test, expect } from '@playwright/test'
import { finalizeEvent } from 'nostr-tools'
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
    await expect(a.page.getByRole('button', { name: '+ ADD' })).toBeDisabled()
    await b.page.getByText('E2E viaggio', { exact: true }).click()
    await expect(b.page.getByRole('button', { name: 'ACCETTA INVITO' })).toBeVisible()
    await b.page.getByRole('button', { name: 'ACCETTA INVITO' }).click()
    // Regression: creator's signed genesis must be usable without waiting
    // for the relay to echo the exact group definition back to the creator.
    await expect(a.page.getByRole('button', { name: '+ ADD' })).toBeEnabled()
    await a.page.getByRole('button', { name: '+ ADD' }).click()
    await a.page.getByPlaceholder('es. Cena al ristorante').fill('Cena di prova')
    await a.page.getByPlaceholder('21000').fill('600')
    await a.page.getByRole('button', { name: '⚡ ADD EXPENSE' }).click()
    await expect(a.page.getByText('Cena di prova', { exact: true })).toBeVisible()
    await expect(a.page.getByRole('button', { name: 'SALDI' })).toBeVisible()

    await expect(b.page.getByText('Cena di prova', { exact: true })).toBeVisible()
    await expect(b.page.getByRole('button', { name: 'APPROVA SPESA' })).toBeVisible()
    await b.page.getByRole('button', { name: 'APPROVA SPESA' }).click()
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
    expect([...relay.events.values()].filter(e => e.kind === 9591)).toHaveLength(1)
    expect([...relay.events.values()].filter(e => e.kind === 9592)).toHaveLength(1)
    expect([...relay.events.values()].filter(e => e.kind === 9593)).toHaveLength(1)
    const createdGroup = [...relay.events.values()].find(e => e.kind === 30001)
    const genesis = [...relay.events.values()].find(e => e.kind === 9591)
    const acceptance = [...relay.events.values()].find(e => e.kind === 9592)
    const expenseDecision = [...relay.events.values()].find(e => e.kind === 9593)
    expect(JSON.parse(expenseDecision.content).decision).toBe('approve')
    expect(JSON.parse(acceptance.content).decision).toBe('accept')
    expect(JSON.parse(createdGroup.content).revisionEventId).toBe(genesis.id)
    const dTag = createdGroup.tags.find(t => t[0] === 'd')[1]
    const address = `30001:${createdGroup.pubkey}:${dTag}`
    for (const kind of [9000, 9001, 9002]) {
      const signed = [...relay.events.values()].find(e => e.kind === kind)
      expect(signed.tags).toContainEqual(['a', address])
      expect(signed.tags).toContainEqual(['r', genesis.id])
      expect(signed.tags).toContainEqual(['i', acceptance.id])
    }
  } finally {
    await Promise.allSettled([a.context.close(), b.context.close()])
  }
})


test('a signed expense objection never creates a payable balance', async ({ browser }) => {
  const relay = new MemoryNostrRelay()
  const a = await openSignedClient(browser, relay, testSigner(51))
  const b = await openSignedClient(browser, relay, testSigner(52))
  try {
    await login(a.page); await login(b.page)
    await createGroup(a.page, 'Spesa contestabile', b.pubkey)
    await b.page.getByText('Spesa contestabile', { exact: true }).click()
    await b.page.getByRole('button', { name: 'ACCETTA INVITO' }).click()
    await a.page.getByText('Spesa contestabile', { exact: true }).click()
    await expect(a.page.getByRole('button', { name: '+ ADD' })).toBeEnabled()
    await a.page.getByRole('button', { name: '+ ADD' }).click()
    await a.page.getByPlaceholder('es. Cena al ristorante').fill('Spesa non condivisa')
    await a.page.getByPlaceholder('21000').fill('400')
    await a.page.getByRole('button', { name: '⚡ ADD EXPENSE' }).click()
    await expect(b.page.getByRole('button', { name: 'CONTESTA SPESA' })).toBeVisible()
    await b.page.getByRole('button', { name: 'CONTESTA SPESA' }).click()
    await expect(b.page.getByText(/Una spesa e contestata/)).toBeVisible()
    await b.page.getByRole('button', { name: 'SALDI' }).click()
    await expect(b.page.getByText('SALDI NON VERIFICATI.')).toBeVisible()
    expect([...relay.events.values()].filter(e => e.kind === 9001)).toHaveLength(0)
  } finally {
    await Promise.allSettled([a.context.close(), b.context.close()])
  }
})

test('a signed declined invitation never activates balances or expense controls', async ({ browser }) => {
  const relay = new MemoryNostrRelay()
  const a = await openSignedClient(browser, relay, testSigner(41))
  const b = await openSignedClient(browser, relay, testSigner(42))
  try {
    await login(a.page); await login(b.page)
    await createGroup(a.page, 'Invito rifiutato', b.pubkey)
    await a.page.getByText('Invito rifiutato', { exact: true }).click()
    await expect(a.page.getByRole('button', { name: '+ ADD' })).toBeDisabled()
    await b.page.getByText('Invito rifiutato', { exact: true }).click()
    await b.page.getByRole('button', { name: 'RIFIUTA INVITO' }).click()
    await expect(b.page.getByText(/Un invitato ha rifiutato/)).toBeVisible()
    await expect(a.page.getByText(/Un invitato ha rifiutato/)).toBeVisible()
    await expect(a.page.getByRole('button', { name: '+ ADD' })).toBeDisabled()
    expect([...relay.events.values()].filter(e => e.kind === 9000)).toHaveLength(0)
    await b.page.reload()
    await b.page.getByText('Invito rifiutato', { exact: true }).click()
    await expect(b.page.getByText(/Un invitato ha rifiutato/)).toBeVisible()
  } finally {
    await Promise.allSettled([a.context.close(), b.context.close()])
  }
})

test('same d-tag by two authors cannot merge balances or claim unscoped legacy events', async ({ browser }) => {
  const relay = new MemoryNostrRelay()
  const a = testSigner(31)
  const b = testSigner(32)
  const viewer = testSigner(33)
  const id = 'same-d-test'
  const members = [a.pubkey, b.pubkey, viewer.pubkey]
  const createdAt = Math.floor(Date.now() / 1000) - 60
  const sign = (identity, kind, tags, content) => finalizeEvent({
    kind, created_at: createdAt, tags, content: JSON.stringify(content),
  }, identity.secret)
  const signedGroup = (identity, name) => sign(identity, 30001,
    [['d', id], ['t', 'splitsats'], ...members.map(pk => ['p', pk])],
    { id, name, members, createdAt })
  const expense = (identity, amount, name, scoped) => sign(identity, 9000,
    [['g', id], ...(scoped ? [['a', `30001:${identity.pubkey}:${id}`]] : []),
      ['t', 'splitsats'], ...members.map(pk => ['p', pk])],
    { id: name, description: name, amount, paidBy: identity.pubkey,
      splits: [identity.pubkey, viewer.pubkey], category: 'food', createdAt })
  const events = [
    signedGroup(a, 'Colliding Alpha'),
    expense(a, 900, 'Legacy ambiguous', false),
    signedGroup(b, 'Colliding Beta'),
    expense(a, 400, 'Scoped Alpha', true),
    expense(b, 700, 'Scoped Beta', true),
  ]
  for (const event of events) relay.events.set(event.id, event)
  const client = await openSignedClient(browser, relay, viewer)
  try {
    await login(client.page)
    await expect(client.page.getByText('Colliding Alpha', { exact: true })).toBeVisible()
    await expect(client.page.getByText('Colliding Beta', { exact: true })).toBeVisible()
    await client.page.getByText('Colliding Alpha', { exact: true }).click()
    await expect(client.page.getByText('Scoped Alpha', { exact: true })).toBeVisible()
    await expect(client.page.getByText('Legacy ambiguous', { exact: true })).toHaveCount(0)
    await expect(client.page.getByText('TOTALE').locator('..')).toContainText('400 sat')
    await client.page.getByRole('button', { name: '← BACK' }).click()
    await client.page.getByText('Colliding Beta', { exact: true }).click()
    await expect(client.page.getByText('Scoped Beta', { exact: true })).toBeVisible()
    await expect(client.page.getByText('Scoped Alpha', { exact: true })).toHaveCount(0)
    await expect(client.page.getByText('Legacy ambiguous', { exact: true })).toHaveCount(0)
    await expect(client.page.getByText('TOTALE').locator('..')).toContainText('700 sat')
    await expect(client.page.getByRole('alert')).toContainText('vecchie transazioni')
    // No trusted local snapshot is required: after reload signed relay events
    // reconstruct both owner-scoped groups without mixing their balances.
    await client.page.reload()
    await expect(client.page.getByText('Colliding Alpha', { exact: true })).toBeVisible()
    await expect(client.page.getByText('Colliding Beta', { exact: true })).toBeVisible()
    await client.page.getByText('Colliding Alpha', { exact: true }).click()
    await expect(client.page.getByText('TOTALE').locator('..')).toContainText('400 sat')
  } finally {
    await client.context.close()
  }
})
