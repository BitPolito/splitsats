import test from 'node:test'
import assert from 'node:assert/strict'
import { memberExitTags, parseMemberExitRequestEvent, verifyMemberExitProofs,
  assertCanRequestExit, assertCanFinalizeExit } from '../src/lib/member-exits.js'
import { KIND_MEMBER_EXIT } from '../src/lib/constants.js'
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64),R='d'.repeat(64),NEXT='e'.repeat(64),PROOF='f'.repeat(64)
const ts=Math.floor(Date.now()/1000)-300
const group=()=>({id:'trip',pubkey:A,members:[A,B,C],_revisionId:R,_revisionStatus:'verified',
 _financialReviewRequired:false,_expenseReviewRequired:false,_financialHistoryChecked:true,
 _inviteStatus:'accepted',_consentPolicy:'signed-invites-v1',_expensePolicy:'unanimous-expense-v1',
 _groupCreatedAt:ts,_revisions:[{id:R,version:0,createdAt:ts,members:[A,B,C]}],
 proposedExpenses:[],expenses:[],settlements:[],confirmations:[],_expenseDecisions:[],_cancellationDecisions:[],_memberExitRequests:[]})
const req=()=>({id:PROOF,member:B,action:'leave',revisionEventId:R,createdAt:ts+10})
const event=()=>({id:PROOF,kind:KIND_MEMBER_EXIT,pubkey:B,created_at:ts+10,
 tags:memberExitTags(group()),content:JSON.stringify({groupId:'trip',revisionEventId:R,action:'leave'})})

test('member-authored leave intent is signed, head-bound and cannot be forged by owner',()=>{
 assert.deepEqual(parseMemberExitRequestEvent(event(),group()),req())
 assert.equal(parseMemberExitRequestEvent({...event(),pubkey:A},group()),null)
 assert.equal(parseMemberExitRequestEvent({...event(),tags:event().tags.filter(x=>x[0]!=='r')},group()),null)
 assert.equal(parseMemberExitRequestEvent({...event(),content:JSON.stringify({groupId:'other',revisionEventId:R,action:'leave'})},group()),null)
 assert.equal(parseMemberExitRequestEvent({...event(),created_at:ts-1},group()),null)
})
test('member can request voluntary leave only with empty verified history',()=>{
 assert.equal(assertCanRequestExit(group(),B,[],ts+20),true)
 assert.throws(()=>assertCanRequestExit(group(),A,[],ts+20),/non proprietario/)
 const g=group();g.expenses=[{id:'1'}]
 assert.throws(()=>assertCanRequestExit(g,B,[],ts+20),/Storico finanziario/)
 const h=group();h._financialHistoryChecked=false
 assert.throws(()=>assertCanRequestExit(h,B,[],ts+20),/non verificati/)
 assert.throws(()=>assertCanRequestExit(group(),B,[{event:{id:'x'}}],ts+20),/Outbox/)
})
test('owner needs the exact independently signed request and next-second publication',()=>{
 const g=group();g._memberExitRequests=[req()]
 assert.deepEqual(assertCanFinalizeExit(g,A,req(),[],ts+30),[A,C])
 assert.throws(()=>assertCanFinalizeExit(g,C,req(),[],ts+30),/proprietario/)
 assert.throws(()=>assertCanFinalizeExit(g,A,{...req(),id:'1'.repeat(64)},[],ts+30),/univoca/)
 assert.throws(()=>assertCanFinalizeExit(g,A,req(),[],ts+10),/troppo recente/)
 const h=group();h.members=[A,B]
 assert.throws(()=>assertCanFinalizeExit(h,A,req(),[],ts+30),/almeno due membri/)
})
test('exits are verified from immutable owner revision and independent leave signature',()=>{
 const g=group();g.members=[A,C];g._revisionId=NEXT
 g._revisions.push({id:NEXT,version:1,createdAt:ts+20,members:[A,C],exitedMember:B,exitProofEventId:PROOF})
 assert.equal(verifyMemberExitProofs(g,[req()]),'verified')
 assert.equal(verifyMemberExitProofs(g,[]),'pending')
 assert.equal(verifyMemberExitProofs(g,[{...req(),id:'1'.repeat(64)}]),'conflict')
 assert.equal(verifyMemberExitProofs(g,[req(),{...req(),id:'2'.repeat(64)}]),'conflict')
 assert.equal(verifyMemberExitProofs(g,[{...req(),createdAt:ts+30}]),'conflict')
})
test('unconsented or mixed member removals are never approved',()=>{
 const g=group();g.members=[A,C];g._revisionId=NEXT
 g._revisions.push({id:NEXT,version:1,createdAt:ts+20,members:[A,C]})
 assert.equal(verifyMemberExitProofs(g,[req()]),'conflict')
 const h=group();h.members=[A,C,'9'.repeat(64)];h._revisionId=NEXT
 h._revisions.push({id:NEXT,version:1,createdAt:ts+20,members:h.members,exitedMember:B,exitProofEventId:PROOF})
 assert.equal(verifyMemberExitProofs(h,[req()]),'conflict')
})
