import test from 'node:test'
import assert from 'node:assert/strict'
import { assertCanAddGroupMember } from '../src/lib/member-additions.js'

const A='a'.repeat(64), B='b'.repeat(64), C='c'.repeat(64), R='d'.repeat(64)
const blank = () => ({ id:'trip', pubkey:A, members:[A,B],
  _revisionId:R, _revisionStatus:'verified', _financialReviewRequired:false,
  _expenseReviewRequired:false, _financialHistoryChecked:true, _inviteStatus:'accepted',
  _consentPolicy:'signed-invites-v1', _expensePolicy:'unanimous-expense-v1',
  _groupCreatedAt:100, _revisions:[{id:R, version:0, members:[A,B]}],
  proposedExpenses:[],expenses:[],settlements:[],confirmations:[],
  _expenseDecisions:[],_cancellationDecisions:[] })
const check=(g=blank(), actor=A, member=C, outstanding=[],time=200) =>
  assertCanAddGroupMember(g,actor,member,outstanding,time)

test('owner can add a valid new participant only after empty history and acceptance',()=>{
  assert.deepEqual(check(),[A,B,C])
  assert.deepEqual(blank().members,[A,B])
})
test('only group owner may initiate change, and invalid/duplicate keys are refused',()=>{
  assert.throws(()=>check(blank(),B),/Solo il creatore/)
  assert.throws(()=>check(blank(),A,'invalid'),/Chiave Nostr/)
  assert.throws(()=>check(blank(),A,B),/Chiave Nostr/)
})
test('no modification before invitations and full revision/ledger synchronization',()=>{
  for(const field of ['_revisionStatus','_inviteStatus']) {
    const g=blank();g[field]='pending';assert.throws(()=>check(g))
  }
  const g=blank();g._financialHistoryChecked=false;assert.throws(()=>check(g),/Storico/)
  const h=blank();h._revisionId='e'.repeat(64);assert.throws(()=>check(h),/Catena/)
  const z=blank();z._financialReviewRequired=true;assert.throws(()=>check(z))
})
test('every known financial operation or pending signed event blocks changes',()=>{
  for(const field of ['proposedExpenses','expenses','settlements','confirmations','_expenseDecisions','_cancellationDecisions']) {
    const g=blank();g[field]=[{id:'old'}];assert.throws(()=>check(g),/attivita finanziaria/)
    const h=blank();delete h[field];assert.throws(()=>check(h),/attivita finanziaria/)
  }
  assert.throws(()=>check(blank(),A,C,[{event:{id:'pending'}}]),/Outbox/)
})
test('cannot exceed member/version limit, restore removed members, or overwrite same-second metadata',()=>{
  const g=blank();g.members=[A,...Array.from({length:99},(_,i)=>i.toString(16).padStart(64,'0'))]
  assert.throws(()=>check(g),/Numero/)
  const h=blank();h._groupCreatedAt=200;assert.throws(()=>check(h),/secondo/)
  const x=blank();x._revisions.push({id:'e'.repeat(64), version:1, members:[A]});x._revisionId='e'.repeat(64)
  assert.throws(()=>check(x),/Modifiche precedenti/)
})
