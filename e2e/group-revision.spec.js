import { test, expect } from '@playwright/test'
import { finalizeEvent } from 'nostr-tools'
import { MemoryNostrRelay, openSignedClient, testSigner } from './relay-harness.js'

// History is deliberately missing: a relay ACK for the group definition is
// NOT evidence that the group has a complete membership revision history.
test('missing immutable group genesis blocks balances and financial actions', async ({ browser }) => {
  const relay = new MemoryNostrRelay()
  const creator = testSigner(51)
  const viewer = testSigner(52)
  const groupId = 'missing-signed-revision'
  const missingHead = 'f'.repeat(64)
  const members = [creator.pubkey, viewer.pubkey]
  const now = Math.floor(Date.now() / 1000)
  const event = finalizeEvent({
    kind: 30001,
    created_at: now - 10,
    tags: [['d', groupId], ['r', missingHead], ['t', 'splitsats'],
      ...members.map(pk => ['p', pk])],
    content: JSON.stringify({ id: groupId, name: 'History unavailable',
      members, revisionEventId: missingHead, createdAt: now - 10 }),
  }, creator.secret)
  relay.events.set(event.id, event)
  const client = await openSignedClient(browser, relay, viewer)
  try {
    await client.page.getByRole('button', { name: /CONNECT WALLET/ }).click()
    await expect(client.page.getByText('History unavailable', { exact: true })).toBeVisible()
    await client.page.getByText('History unavailable', { exact: true }).click()
    await expect(client.page.getByRole('alert')).toContainText('Registro delle revisioni Nostr incompleto')
    await expect(client.page.getByRole('button', { name: '+ ADD' })).toBeDisabled()
    await client.page.getByRole('button', { name: 'SALDI' }).click()
    await expect(client.page.getByText('SALDI NON VERIFICATI.')).toBeVisible()
    await expect(client.page.getByText('TUTTI IN PARI!')).toHaveCount(0)
    expect([...relay.events.values()].filter(e => e.kind === 9000)).toHaveLength(0)
  } finally {
    await client.context.close()
  }
})
