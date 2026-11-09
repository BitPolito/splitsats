import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SPLITSATS_PROTOCOL_KINDS, SPLITSATS_SCHEMA_VERSION,
  inspectSplitSatsSchema, isReadableSplitSatsSchema,
} from '../src/lib/protocol-schema.js'
import {
  parseGroupEvent, parseExpenseEvent, parseSettlementEvent,
  parseConfirmationEvent,
} from '../src/lib/event-validation.js'
import { parseGroupRevisionEvent, revisionTags } from '../src/lib/group-revision-log.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), ID = 'f'.repeat(64)
const H = '1'.repeat(64), timestamp = Math.floor(Date.now()/1000)-120
const g = {id:'trip',pubkey:A,members:[A,B],_revisionId:H}
const event = (kind, data, tags, signer=A) => ({
  id:ID, kind, pubkey:signer, created_at:timestamp, tags,
  content:JSON.stringify(data),
})
const common = [['g','trip'], ['a',`30001:${A}:trip`],['t','splitsats']]
const makeGroup = content => event(30001,content,
  [['d','trip'],['t','splitsats'],['p',A],['p',B]])
const makeExpense = content => event(9000,content,common)
const makeSettlement = content => event(9001,content,[...common,['p',A]],B)
const makeReceipt = content => event(9002,content,[...common,['p',B],['e',H]],A)
const payloads = {
  group: {id:'trip',name:'Trip',members:[A,B]},
  expense: {id:'expense-1',description:'Test',amount:5,paidBy:A,splits:[A,B]},
  settlement: {id:'payment-1',from:B,to:A,amount:5},
  receipt: {settlementEventId:H,from:B,to:A,amount:5},
}

test('registry lists legacy and v2 SplitSats application kinds',()=>{
  assert.equal(SPLITSATS_PROTOCOL_KINDS.length,15)
  assert.equal(new Set(SPLITSATS_PROTOCOL_KINDS.map(x=>x.kind)).size,15)
  assert.equal(SPLITSATS_SCHEMA_VERSION,1)
  assert.deepEqual(SPLITSATS_PROTOCOL_KINDS.map(x=>x.kind).sort((a,b)=>a-b),
    [9000,9001,9002,9591,9592,9593,9594,9595,9596,9597,9598,9600,9601,9602,30001])
})

test('NIP-01 profile and unknown kinds are not reinterpreted as application content',()=>{
  assert.equal(inspectSplitSatsSchema(0,{name:'Alice'}).status,'not-app-kind')
  assert.equal(inspectSplitSatsSchema(9599,{version:1}).readable,false)
})

test('old signed group and financial payloads are still readable without schemaVersion',()=>{
  for(const kind of [30001,9000,9001,9002,9592,9593,9594,9595]){
    assert.equal(inspectSplitSatsSchema(kind,{action:'legacy'}).status,'legacy')
    assert.equal(isReadableSplitSatsSchema(kind,{action:'legacy'}),true)
  }
})

test('new schemaVersion 1 is accepted only for the already-compatible shapes',()=>{
  for(const kind of [30001,9000,9001,9002,9591,9592,9593,9594,9595])
    assert.equal(inspectSplitSatsSchema(kind,{schemaVersion:1}).status,'schema-v1')
})

test('future, malformed, fractional and ambiguous schema markers fail closed',()=>{
  for(const value of [2,0,-1,'1',null,false,1.5,{},NaN,Infinity]){
    assert.equal(isReadableSplitSatsSchema(9000,{schemaVersion:value}),false)
    assert.equal(isReadableSplitSatsSchema(9591,{schemaVersion:value,version:1}),false)
  }
  assert.equal(inspectSplitSatsSchema(9000,{protocolVersion:1}).reason,'ambiguous-version-field')
  assert.equal(inspectSplitSatsSchema(9000,{schemaVersion:1,protocolVersion:1}).readable,false)
})

test('array, string, null and other invalid content shapes are refused',()=>{
  for(const v of [null,[],5,'abc',false])
    assert.equal(inspectSplitSatsSchema(9000,v).status,'invalid-content')
})

test('9591 version remains a revision sequence, never the schema version',()=>{
  for (const sequence of [0,1,2,50,100])
    assert.equal(inspectSplitSatsSchema(9591,{version:sequence}).status,'legacy')
  assert.equal(inspectSplitSatsSchema(9591,{version:100,schemaVersion:1}).status,'schema-v1')
})

test('9596-9598 maintain their immutable action-v1 payload versions',()=>{
  for(const kind of [9596,9597,9598]){
    assert.equal(inspectSplitSatsSchema(kind,{version:1}).status,'native-v1')
    for(const value of [undefined,0,2,'1',-1])
      assert.equal(inspectSplitSatsSchema(kind,{version:value}).readable,false)
    assert.equal(inspectSplitSatsSchema(kind,{version:1,schemaVersion:1}).readable,false)
  }
})

test('group parser accepts old signed content and opt-in schema-v1, rejects schema-v2',()=>{
  assert.ok(parseGroupEvent(makeGroup(payloads.group),B))
  assert.ok(parseGroupEvent(makeGroup({...payloads.group,schemaVersion:1}),B))
  assert.equal(parseGroupEvent(makeGroup({...payloads.group,schemaVersion:2}),B),null)
  assert.equal(parseGroupEvent(makeGroup({...payloads.group,protocolVersion:1}),B),null)
})

test('expense parser cannot silently downcast an unknown future schema to legacy debt',()=>{
  assert.ok(parseExpenseEvent(makeExpense(payloads.expense),g))
  assert.ok(parseExpenseEvent(makeExpense({...payloads.expense,schemaVersion:1}),g))
  assert.equal(parseExpenseEvent(makeExpense({...payloads.expense,schemaVersion:2}),g),null)
  assert.equal(parseExpenseEvent(makeExpense({...payloads.expense,protocolVersion:1}),g),null)
})

test('settlement claims reject unknown schema without interpreting them as paid',()=>{
  assert.ok(parseSettlementEvent(makeSettlement(payloads.settlement),g))
  assert.ok(parseSettlementEvent(makeSettlement({...payloads.settlement,schemaVersion:1}),g))
  assert.equal(parseSettlementEvent(makeSettlement({...payloads.settlement,schemaVersion:2}),g),null)
})

test('recipient receipts reject unknown schema rather than clearing a debt',()=>{
  assert.ok(parseConfirmationEvent(makeReceipt(payloads.receipt),g))
  assert.ok(parseConfirmationEvent(makeReceipt({...payloads.receipt,schemaVersion:1}),g))
  assert.equal(parseConfirmationEvent(makeReceipt({...payloads.receipt,schemaVersion:2}),g),null)
})

test('immutable revision parser keeps version=0 for genesis and rejects future schema',()=>{
  const tags=revisionTags(g,[A,B],null)
  const make = body => event(9591,body,tags)
  const payload={groupId:'trip',version:0,previousRevisionId:null,members:[A,B]}
  assert.ok(parseGroupRevisionEvent(make(payload),g))
  assert.ok(parseGroupRevisionEvent(make({...payload,schemaVersion:1}),g))
  assert.equal(parseGroupRevisionEvent(make({...payload,schemaVersion:2}),g),null)
  assert.equal(parseGroupRevisionEvent(make({...payload,protocolVersion:1}),g),null)
})
