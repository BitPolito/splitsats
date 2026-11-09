import test from 'node:test'
import assert from 'node:assert/strict'
import {
  KIND_EXPENSE, KIND_SETTLEMENT, KIND_CONFIRMATION,
  KIND_EXPENSE_V2, KIND_SETTLEMENT_V2, KIND_CONFIRMATION_V2,
} from '../src/lib/constants.js'
import { inspectSplitSatsSchema, isReadableSplitSatsSchema,
  SPLITSATS_PROTOCOL_KINDS } from '../src/lib/protocol-schema.js'
import { parseExpenseEvent, parseSettlementEvent, parseConfirmationEvent } from '../src/lib/event-validation.js'

const A='a'.repeat(64), B='b'.repeat(64), HEAD='1'.repeat(64), ID='f'.repeat(64)
const now=Math.floor(Date.now()/1000)-90
const group={id:'trip',pubkey:A,members:[A,B],_revisionId:HEAD}
const core=[['g','trip'],['a',`30001:${A}:trip`],['r',HEAD],['v','2'],['t','splitsats']]
const signed=(kind,body,tags,author=A)=>({id:ID,pubkey:author,kind,created_at:now,
  tags,content:JSON.stringify(body)})
const expense={id:'expense1',description:'Dinner',amount:101,paidBy:A,splits:[A,B]}
const claim={id:'payment1',from:B,to:A,amount:51,method:'manual'}
const receipt={settlementEventId:HEAD,from:B,to:A,amount:51}
const v2=(kind,action,body,tags=core,author=A)=>signed(kind,
  {...body,action,schemaVersion:2},tags,author)
const sampleExpense=()=>v2(KIND_EXPENSE_V2,'expense-v2',expense)
const sampleClaim=()=>v2(KIND_SETTLEMENT_V2,'settlement-claim-v2',claim,
  [...core,['p',A]],B)
const sampleReceipt=()=>v2(KIND_CONFIRMATION_V2,'recipient-receipt-v2',receipt,
  [...core,['e',HEAD],['p',B]],A)
const replaceBody=(ev,body)=>({...ev,content:JSON.stringify(body)})

// Parsing fixtures deliberately omit Schnorr signatures: in the app only the
// relay's verifyEvent gate may pass envelopes to these parser functions.
test('v2 kind assignments are distinct and outside NIP-29 moderation kinds',()=>{
  const kinds=[KIND_EXPENSE_V2,KIND_SETTLEMENT_V2,KIND_CONFIRMATION_V2]
  assert.deepEqual(kinds,[9600,9601,9602])
  assert.equal(new Set(kinds).size,3)
  assert.ok(kinds.every(k=>k>9030 && k>=1000 && k<10000))
  assert.deepEqual([KIND_EXPENSE,KIND_SETTLEMENT,KIND_CONFIRMATION],[9000,9001,9002])
})
test('v2 kinds are registered with v2-only schema admission',()=>{
  assert.equal(SPLITSATS_PROTOCOL_KINDS.length,15)
  assert.equal(new Set(SPLITSATS_PROTOCOL_KINDS.map(e=>e.kind)).size,15)
  for(const kind of [9600,9601,9602]) {
    assert.equal(inspectSplitSatsSchema(kind,{schemaVersion:2}).status,'schema-v2')
    for(const payload of [{},{schemaVersion:1},{schemaVersion:'2'},{schemaVersion:3},
      {schemaVersion:2,protocolVersion:2},{schemaVersion:2,version:1}])
      assert.equal(isReadableSplitSatsSchema(kind,payload),false)
  }
  for(const old of [9000,9001,9002]) {
    assert.equal(isReadableSplitSatsSchema(old,{schemaVersion:2}),false)
    assert.equal(isReadableSplitSatsSchema(old,{schemaVersion:1}),true)
    assert.equal(isReadableSplitSatsSchema(old,{}),true)
  }
})
test('v2 expense is parsed only after binding schema, action, group and revision',()=>{
  const parsed=parseExpenseEvent(sampleExpense(),group)
  assert.equal(parsed?.amount,101)
  assert.equal(parsed?._eventId,ID)
  assert.equal(parsed?._pubkey,A)
  assert.equal(parsed?.paidBy,A)
})
test('v2 settlement is still only a debtor claim, not a receipt',()=>{
  const parsed=parseSettlementEvent(sampleClaim(),group)
  assert.equal(parsed?._eventId,ID)
  assert.equal(parsed?.from,B)
  assert.equal(parsed?.to,A)
  assert.equal(parsed?.walletReported,false)
})
test('v2 confirmation preserves exact original claim event reference',()=>{
  const parsed=parseConfirmationEvent(sampleReceipt(),group)
  assert.equal(parsed?.settlementEventId,HEAD)
  assert.equal(parsed?._eventId,ID)
  assert.equal(parsed?.from,B)
  assert.equal(parsed?.to,A)
})
test('new kind refuses missing, repeated or forged signed v2 marker',()=>{
  const event=sampleExpense()
  const alternatives=[event.tags.filter(t=>t[0]!=='v'),
    [...event.tags,['v','2']],event.tags.map(t=>t[0]==='v'?['v','1']:t),
    [...event.tags,['h','forged-moderation-group']]]
  for(const tags of alternatives) assert.equal(parseExpenseEvent({...event,tags},group),null)
})
test('new kind refuses absent, spoofed and repeated group or revision tags',()=>{
  const event=sampleExpense()
  for(const tags of [
    event.tags.filter(t=>t[0]!=='a'),
    event.tags.filter(t=>t[0]!=='r'),
    [...event.tags,['a','30001:'+B+':trip']],
    [...event.tags,['r',HEAD]],
    event.tags.map(t=>t[0]==='r'?['r',A]:t),
    event.tags.map(t=>t[0]==='a'?['a',`30001:${B}:trip`]:t),
  ]) assert.equal(parseExpenseEvent({...event,tags},group),null)
  assert.equal(parseExpenseEvent(event,{...group,_revisionId:B}),null)
  assert.equal(parseExpenseEvent(event,{...group,pubkey:B}),null)
})
test('wrong action or schema marker cannot be downcast to a balance',()=>{
  const exp=sampleExpense(),c=JSON.parse(exp.content)
  for(const changes of [
    {action:'settlement-claim-v2'}, {schemaVersion:1}, {schemaVersion:3},
    {schemaVersion:'2'}, {protocolVersion:2}, {version:2},
  ]) assert.equal(parseExpenseEvent(replaceBody(exp,{...c,...changes}),group),null)
  assert.equal(parseSettlementEvent(replaceBody(sampleClaim(),{...claim,action:'expense-v2',schemaVersion:2}),group),null)
  assert.equal(parseConfirmationEvent(replaceBody(sampleReceipt(),{...receipt,action:'expense-v2',schemaVersion:2}),group),null)
})
test('new kind cannot be substituted into another financial parser',()=>{
  assert.equal(parseSettlementEvent(sampleExpense(),group),null)
  assert.equal(parseConfirmationEvent(sampleClaim(),group),null)
  assert.equal(parseExpenseEvent(sampleReceipt(),group),null)
})
test('legacy signed IDs and payloads still parse unchanged',()=>{
  const oldTags=[['g','trip'],['a',`30001:${A}:trip`],['t','splitsats']]
  assert.ok(parseExpenseEvent(signed(KIND_EXPENSE,expense,oldTags),group))
  assert.ok(parseSettlementEvent(signed(KIND_SETTLEMENT,claim,[...oldTags,['p',A]],B),group))
  assert.ok(parseConfirmationEvent(signed(KIND_CONFIRMATION,receipt,
    [...oldTags,['e',HEAD],['p',B]]),group))
})
test('v2 cannot mask broken underlying financial authorization',()=>{
  assert.equal(parseExpenseEvent(v2(KIND_EXPENSE_V2,'expense-v2',{...expense,amount:0}),group),null)
  assert.equal(parseExpenseEvent(v2(KIND_EXPENSE_V2,'expense-v2',{...expense,splits:[B,B]}),group),null)
  assert.equal(parseSettlementEvent(v2(KIND_SETTLEMENT_V2,'settlement-claim-v2',claim,[...core,['p',A]],A),group),null)
  assert.equal(parseConfirmationEvent(v2(KIND_CONFIRMATION_V2,'recipient-receipt-v2',receipt,[...core,['e',HEAD],['p',B]],B),group),null)
})
