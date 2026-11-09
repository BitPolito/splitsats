import test from 'node:test'
import assert from 'node:assert/strict'
import { FinancialKindQuarantine, MIXED_FINANCIAL_KINDS, liveFinancialRelayRiskReasons } from '../src/lib/financial-kind-quarantine.js'
import { RelaySnapshotAudit } from '../src/lib/relay-snapshot-audit.js'
const A = 'a'.repeat(64), B = 'b'.repeat(64), H = '1'.repeat(64)
const G = { id: 'trip', pubkey: A, members: [A, B], _revisionId: H, _revisionStatus: 'verified' }
const now = Math.floor(Date.now() / 1000) - 90
const tags = (kind) => [
  ['a', `30001:${A}:trip`], ['g', 'trip'], ['r', H], ['t', 'splitsats'],
  ...(kind >= 9600 ? [['v', '2']] : []),
  ...(kind === 9001 || kind === 9601 ? [['p', B]] : []),
]
function event(kind, id = 'f'.repeat(64), logicalId='pay-one') {
  const exp = kind === 9000 || kind === 9600
  const body = exp
    ? { id: logicalId, description:'Lunch', amount:30, paidBy:A, splits:[A,B] }
    : { id:logicalId, from:A, to:B, amount:20, method:'manual' }
  if (kind >= 9600) {
    body.schemaVersion = 2
    body.action = exp ? 'expense-v2' : kind === 9601 ? 'settlement-claim-v2' : 'recipient-receipt-v2'
  }
  return { id, pubkey:A, kind, created_at:now, tags:tags(kind), content: JSON.stringify(body), sig:'f'.repeat(128) }
}
test('all three old and v2 finance families are covered',()=>{
  assert.deepEqual([...MIXED_FINANCIAL_KINDS].sort((a,b)=>a-b),[9000,9001,9002,9600,9601,9602])
})
test('legacy signed event is observed but never certified payable',()=>{
  const guard = new FinancialKindQuarantine(G)
  const result=guard.observe(event(9000))
  assert.equal(result.status,'observing')
  assert.equal(result.safeForPayments,false)
  assert.equal(result.completeHistory,false)
})
test('same signed event replayed from other relay is idempotent',()=>{
  const guard = new FinancialKindQuarantine(G), e=event(9000)
  guard.observe(e)
  assert.equal(guard.observe(e).observedEventCount,1)
  assert.deepEqual(guard.report().reasons,[])
})
test('any valid v2 expense is quarantined before it reaches legacy balances',()=>{
  const guard = new FinancialKindQuarantine(G)
  assert.equal(guard.observe(event(9600)).status,'quarantine')
  assert.ok(guard.report().reasons.includes('v2-financial-event-observed'))
})
test('invalid v2 schema is still evidence and must quarantine',()=>{
  const guard = new FinancialKindQuarantine(G), e=event(9600)
  e.content=JSON.stringify({...JSON.parse(e.content),schemaVersion:3})
  guard.observe(e)
  assert.ok(guard.report().reasons.includes('unreadable-v2-event'))
})
test('valid v2 debtor claim is quarantined, not credited',()=>{
  const guard = new FinancialKindQuarantine(G)
  const report = guard.observe(event(9601))
  assert.equal(report.status,'quarantine')
  assert.ok(report.reasons.includes('v2-financial-event-observed'))
  assert.ok(!report.reasons.includes('unreadable-v2-event'))
})
test('valid recipient-signed v2 receipt is quarantined, never a settlement',()=>{
  const guard = new FinancialKindQuarantine(G)
  const e = event(9602)
  const body = { ...JSON.parse(e.content), id:'receipt-one', from:B, to:A,
    settlementEventId:'c'.repeat(64), amount:20 }
  const report = guard.observe({ ...e, content:JSON.stringify(body),
    tags:[...e.tags, ['e','c'.repeat(64)], ['p',B]] })
  assert.equal(report.status,'quarantine')
  assert.ok(!report.reasons.includes('unreadable-v2-event'))
})
test('old/new same application operation cannot double count',()=>{
  const guard = new FinancialKindQuarantine(G)
  guard.observe(event(9000,'1'.repeat(64),'same-expense'))
  guard.observe(event(9600,'2'.repeat(64),'same-expense'))
  assert.ok(guard.report().reasons.includes('mixed-kind-duplicate'))
})
test('different signed events of the same kind and logical ID conflict',()=>{
  const guard = new FinancialKindQuarantine(G)
  guard.observe(event(9000,'1'.repeat(64),'same-expense'))
  guard.observe(event(9000,'2'.repeat(64),'same-expense'))
  assert.ok(guard.report().reasons.includes('duplicate-operation-id'))
})
test('same signed ID with different immutable envelope is conflict',()=>{
  const guard = new FinancialKindQuarantine(G), e=event(9000)
  guard.observe(e)
  guard.observe({...e, content: e.content.replace('Lunch','Dinner')})
  assert.ok(guard.report().reasons.includes('same-id-different-envelope'))
})
test('cross-author group and revision contamination is quarantined',()=>{
  for (const change of [
    e=>({...e,tags:e.tags.map(t=>t[0]==='a'?['a','30001:'+B+':trip']:t)}),
    e=>({...e,tags:e.tags.map(t=>t[0]==='r'?['r','2'.repeat(64)]:t)}),
    e=>({...e,pubkey:'c'.repeat(64)}),
  ]){
    const guard = new FinancialKindQuarantine(G)
    assert.equal(guard.observe(change(event(9000))).status,'quarantine')
  }
})
test('known incompatible Nostr kinds do not enter group audit',()=>{
  const guard=new FinancialKindQuarantine(G)
  const result=guard.observe({...event(9000),kind:12345})
  assert.equal(result.observedEventCount,0)
  assert.equal(result.status,'observing')
})
test('once quarantined, later good relay events never remove the lock',()=>{
  const guard = new FinancialKindQuarantine(G)
  guard.observe(event(9600,'1'.repeat(64)))
  guard.observe(event(9000,'2'.repeat(64)))
  assert.equal(guard.report().status,'quarantine')
})
test('unverified or headless groups cannot construct a migration watcher',()=>{
  assert.throws(()=>new FinancialKindQuarantine({...G,_revisionId:null}))
  assert.throws(()=>new FinancialKindQuarantine({...G,_revisionStatus:'pending'}))
})
test('limit is sticky and event samples bounded',()=>{
  const guard = new FinancialKindQuarantine(G)
  for (let i=0;i<500;i++){
    const e=event(9000,i.toString(16).padStart(64,'0'),'expense-'+i)
    guard.observe(e)
  }
  const r=guard.report()
  assert.equal(r.status,'quarantine')
  assert.ok(r.reasons.includes('audit-cap-reached'))
  assert.ok(r.sampleEventIds.length<=8)
})

// Regression for three Playwright failures: a legitimate expense published
// after the subscription's EOSE MUST still reach the other participant.
test('live expense after EOSE does not become a sticky finance quarantine',()=>{
  const relays=['wss://one.example','wss://two.example']
  const audit=new RelaySnapshotAudit(relays)
  relays.forEach(r=>audit.eose(r))
  const signed=event(9000)
  const guard=new FinancialKindQuarantine(G)
  audit.record(relays[0],signed)
  guard.observe(signed)
  assert.equal(audit.report().status,'changed-after-eose')
  assert.equal(guard.report().status,'observing')
  assert.deepEqual(liveFinancialRelayRiskReasons(audit.report()),[])
  audit.record(relays[1],signed)
  assert.deepEqual(liveFinancialRelayRiskReasons(audit.report()),[])
})

test('eventual propagation mismatch between active relays is not permanent quarantine',()=>{
  const relays=['wss://one.example','wss://two.example']
  const audit=new RelaySnapshotAudit(relays)
  const e=event(9000)
  audit.record(relays[0],e)
  relays.forEach(r=>audit.eose(r))
  assert.equal(audit.report().status,'divergent')
  assert.deepEqual(liveFinancialRelayRiskReasons(audit.report()),[])
  audit.record(relays[1],e)
  assert.deepEqual(liveFinancialRelayRiskReasons(audit.report()),[])
})

test('signed v2 event remains quarantined even after live EOSE',()=>{
  const audit=new RelaySnapshotAudit(['wss://one.example','wss://two.example'])
  audit.eose('wss://one.example')
  audit.eose('wss://two.example')
  const v2=event(9600)
  audit.record('wss://one.example',v2)
  const report=new FinancialKindQuarantine(G).observe(v2)
  const reasons=[...report.reasons,...liveFinancialRelayRiskReasons(audit.report())]
  assert.ok(reasons.includes('v2-financial-event-observed'))
})

test('relay contradictions, overflow and saturation still quarantine immediately',()=>{
  const report={relays:[
    {conflict:true,overflow:false,saturated:false},
    {conflict:false,overflow:true,saturated:true},
  ]}
  assert.deepEqual(liveFinancialRelayRiskReasons(report),
    ['relay-conflict','relay-overflow','relay-at-limit'])
  assert.deepEqual(liveFinancialRelayRiskReasons({relays:[]}),[])
  assert.deepEqual(liveFinancialRelayRiskReasons(null),['relay-audit-invalid'])
})

test('audit report with late/missing events but no corruption does not lock',()=>{
  const audit={status:'changed-after-eose',relays:[
    {eose:true,lateEvents:true,notObservedCount:1,conflict:false,overflow:false,saturated:false},
    {eose:true,lateEvents:false,notObservedCount:0,conflict:false,overflow:false,saturated:false},
  ]}
  assert.deepEqual(liveFinancialRelayRiskReasons(audit),[])
})
