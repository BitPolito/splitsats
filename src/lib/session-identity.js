// A cached Nostr pubkey is only a hint. Never render cached account data until
// the active NIP-07 signer has been checked against it.
const VALID_KEY = /^[0-9a-f]{64}$/

export async function verifyCachedSigner(cachedPubkey, signer) {
  if (!VALID_KEY.test(cachedPubkey || '') || typeof signer?.getPublicKey !== 'function') return null
  try {
    const current = await signer.getPublicKey()
    return current === cachedPubkey ? cachedPubkey : null
  } catch {
    return null
  }
}
