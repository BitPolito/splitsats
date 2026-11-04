import test from 'node:test'
import assert from 'node:assert/strict'
import { CONSENT_POLICY, invitationTags, parseInvitationDecisionEvent,
  invitationSummary, invitationReceiptTags, hasInvitationReceipts } from '../src/lib/group-invitations.js'
import { KIND_GROUP_INVITATION } from '../src/lib/constants.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)
const REV = 'e'.repeat(64), ACCEPT_B = 'f'.repeat(64), ACCEPT_C = '1'.repeat(64)
const group = { id: 'demo', pubkey: A, members: [A,B,C], _revisionId: REV,
  _consentPolicy: CONSENT_POLICY, _revisionStatus: 'verified',
  _revisions: [{createdAt: 100}] }
const at = 200
const event = (pk,decision,id=ACCEPT_B,opts={}) => ({ id, pubkey:pk, kind:KIND_GROUP_INVITATION,
  created_at:at, tags:invitationTags(group),
  content:JSON.stringify({groupId:group.id,revisionEventId:group._revisionId,decision}),...opts })
const yesB = {id:ACCEPT_B,member:B,decision:'accept',revisionEventId:REV,createdAt:at}
const yesC = {id:ACCEPT_C,member:C,decision:'accept',revisionEventId:REV,createdAt:at}

test('signed acceptance is bound to signer, group, owner, exact revision and tags', () => {
  assert.deepEqual(parseInvitationDecisionEvent(event(B,'accept'),group),yesB)
  assert.equal(parseInvitationDecisionEvent(event(A,'accept'),group),null)
  assert.equal(parseInvitationDecisionEvent(event('d'.repeat(64),'accept'),group),null)
  assert.equal(parseInvitationDecisionEvent(event(B,'accept',ACCEPT_B,{tags:[...invitationTags(group),['a','wrong']]}),group),null)
  assert.equal(parseInvitationDecisionEvent(event(B,'accept',ACCEPT_B,{tags:invitationTags({...group,_revisionId:'2'.repeat(64)})}),group),null)
  assert.equal(parseInvitationDecisionEvent(event(B,'accept',ACCEPT_B,{content:'broken'}),group),null)
})

test('pending until all invitees accept; owner is implicit',()=>{
  assert.equal(invitationSummary(group,[]).status,'pending')
  assert.deepEqual(invitationSummary(group,[yesB]).pending,[C])
  const result=invitationSummary(group,[yesC,yesB]);assert.equal(result.status,'accepted')
  assert.deepEqual(result.acceptances.map(x=>x.member),[B,C])
})

test('declining an invite blocks the group and a second decision conflicts',()=>{
  assert.equal(invitationSummary(group,[yesB,{...yesC,decision:'decline'}]).status,'declined')
  assert.equal(invitationSummary(group,[yesB,{...yesB,id:'3'.repeat(64),decision:'decline'}]).status,'conflict')
  assert.equal(invitationSummary({...group,_revisionStatus:'pending'},[yesB,yesC]).status,'pending')
})

test('transaction receipts bind every accepted member to the signed event',()=>{
  const verified={...group,_inviteDecisions:[yesB,yesC]}
  assert.deepEqual(invitationReceiptTags(verified),[['i',ACCEPT_B],['i',ACCEPT_C]])
  const event={created_at:201,tags:[['i',ACCEPT_B],['i',ACCEPT_C]]}
  assert.equal(hasInvitationReceipts(verified,event),true)
  assert.equal(hasInvitationReceipts(verified,{...event,tags:[['i',ACCEPT_B]]}),false)
  assert.equal(hasInvitationReceipts(verified,{...event,tags:[['i',ACCEPT_B],['i',ACCEPT_B]]}),false)
  assert.equal(hasInvitationReceipts(verified,{...event,created_at:199}),false)
  assert.throws(()=>invitationReceiptTags(group),/Inviti/)
})

test('legacy groups remain compatible while new consent stays opt-in',()=>{
  const legacy={...group,_consentPolicy:null}
  assert.equal(invitationSummary(legacy).status,'legacy')
  assert.equal(hasInvitationReceipts(legacy,{tags:[],created_at:1}),true)
})
