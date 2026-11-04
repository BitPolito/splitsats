// Security gate for a signed group revision that follows an earlier head.
// A signed leave request is necessary, but it is not sufficient by itself:
// wait until the previous revision's financial subscription completes its
// initial relay snapshot (EOSE). EOSE is *not* Nostr finality.
export function canResumeAfterPriorHistory(group, exitProofStatus = 'pending') {
  if (!group || group._revisionStatus !== 'verified' ||
      group._priorHistoryChecked !== true || group._historicalActivityDetected === true ||
      !Array.isArray(group._revisions) || group._revisions.length < 2 ||
      group._revisions.at(-1)?.id !== group._revisionId ||
      !Array.isArray(group.members)) return false

  const chain = group._revisions
  if (!chain.every(r => Array.isArray(r.members))) return false
  const hasRemoval = chain.some((r, i) => i > 0 &&
    chain[i - 1].members.some(member => !r.members.includes(member)))
  if (!hasRemoval) return true
  // Legacy unsigned removals must remain financially locked. A signed exit
  // chain needs separately verified requests for EVERY removal step.
  return chain[0].consentPolicy === 'signed-invites-v1' &&
    exitProofStatus === 'verified' && chain.some(r => !!r.exitedMember)
}
