import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFormerMemberExitHint, formerMemberAuditEligibility } from '../src/lib/former-member-audit.js'
const A='a'.repeat(64),B='b'.repeat(64),C='c'.repeat(64)
const R0='0'.repeat(64), R1='1'.repeat(64),E='e'.repeat(64)
const t=Math.floor(Date.now()/1000)-60
const raw=()=>({kind:9595,id:E,pubkey:B,created_at:t+1,tags:[['g','trip'],['a',`30001:${A}:trip`],['r',R0],['p',A],['t','splitsats']],content:JSON.stringify({groupId:'trip',revisionEventId:R0,action:'leave'})})
const g=()=>({id:'trip',pubkey:A,members:[A,C],_revisionStatus:'verified',_revisionId:R1,
 _revisions:[{id:R0,createdAt:t,members:[A,B,C],consentPolicy:'signed-invites-v1'},
 {id:R1,createdAt:t+3,previousRevisionId:R0,members:[A,C],exitedMember:B,exitProofEventId:E}]})
const req=()=>[{id:E,member:B,action:'leave',revisionEventId:R0,createdAt:t+1}]
test('exit hint alone is only a locator, not group access',()=>{
 const h=parseFormerMemberExitHint(raw(),B)
 assert.equal(h.owner,A); assert.equal(h.groupId,'trip');assert.equal(h.member,B)
 assert.equal(formerMemberAuditEligibility(g(),B,h,req(),'pending'),false)
})
test('past member admitted to read-only archive only after signed proof validation',()=>{
 const h=parseFormerMemberExitHint(raw(),B)
 assert.equal(formerMemberAuditEligibility(g(),B,h,req(),'verified'),true)
})
test('wrong signer, owner, tags, or untrusted fields reject a hint',()=>{
 for(const e of [
 {...raw(),pubkey:C},{...raw(),id:'bad'},{...raw(),kind:30001},
 {...raw(),tags:raw().tags.filter(x=>x[0]!=='r')},
 {...raw(),tags:[...raw().tags,['a',`30001:${A}:trip`]]},
 {...raw(),tags:raw().tags.map(x=>x[0]==='p'?['p',B]:x)},
 {...raw(),content:JSON.stringify({action:'leave',groupId:'other',revisionEventId:R0})},
 {...raw(),created_at:t+5000},
 ])assert.equal(parseFormerMemberExitHint(e,B),null)
})
test('unfinalized exit, different proof or forged group head cannot enter archive',()=>{
 const h=parseFormerMemberExitHint(raw(),B)
 assert.equal(formerMemberAuditEligibility(g(),B,{...h,id:C},req(),'verified'),false)
 assert.equal(formerMemberAuditEligibility({...g(),_revisionId:R0},B,h,req(),'verified'),false)
 assert.equal(formerMemberAuditEligibility(g(),B,h,[], 'verified'),false)
 assert.equal(formerMemberAuditEligibility(g(),B,h,[...req(),...req()], 'verified'),false)
 const unfinalized=g();delete unfinalized._revisions[1].exitProofEventId
 assert.equal(formerMemberAuditEligibility(unfinalized,B,h,req(),'verified'),false)
})
test('active group members cannot impersonate archived members',()=>{
 const h=parseFormerMemberExitHint(raw(),B), group={...g(),members:[A,B,C]}
 assert.equal(formerMemberAuditEligibility(group,B,h,req(),'verified'),false)
 assert.equal(formerMemberAuditEligibility(g(),A,h,req(),'verified'),false)
})
test('unsigned legacy removals never establish archival attestation eligibility',()=>{
 const h=parseFormerMemberExitHint(raw(),B), group=g()
 delete group._revisions[0].consentPolicy
 assert.equal(formerMemberAuditEligibility(group,B,h,req(),'verified'),false)
})
