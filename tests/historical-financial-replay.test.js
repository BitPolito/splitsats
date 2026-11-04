import test from 'node:test'
import assert from 'node:assert/strict'
import { appendHistoricalReplayEvent, replayHistoricalFinancialEvents,
  MAX_HISTORICAL_REPLAY_EVENTS } from '../src/lib/historical-financial-replay.js'

const A='a'.repeat(64), B='b'.repeat(64), C='c'.repeat(64)
const R0='0'.repeat(64), R1='1'.repeat(64), R2='2'.repeat(64)
const T=Math.floor(Date.now()/1000)-200
const group=()=>({id:'trip',pubkey:A,members:[A,C],_revisionStatus:'verified',_revisionId:R2,
  _revisions:[{id:R0,createdAt:T,members:[A,B],version:0,previousRevisionId:null,consentPolicy:'signed-invites-v1',expensePolicy:'unanimous-expense-v1'},
    {id:R1,createdAt:T+70,members:[A,B],version:1,previousRevisionId:R0},
    {id:R2,createdAt:T+140,members:[A,C],version:2,previousRevisionId:R1}]})
const addr=`30001:${A}:trip`
const h=n=>n.toString(16).padStart(64,'0')
const ev=(kind,author,head,id,sec,data,tags=[])=>({kind,pubkey:author,id:h(id),created_at:T+sec,
  tags:[['g','trip'],['a',addr],['r',head],['t','splitsats'],...tags],content:JSON.stringify(data)})
const accept=(head,id,sec)=>ev(9592,B,head,id,sec,
  {groupId:'trip',revisionEventId:head,decision:'accept'},[['p',A]])
const expense=(head,id,sec,by,amount)=>ev(9000,by,head,id,sec,
  {id:`exp${id}`,description:'Spesa condivisa',paidBy:by,amount,splits:[A,B]},
  [['i',head===R0?h(1):h(10)]])
const approval=(head,id,sec,member,exp,author)=>ev(9593,member,head,id,sec,
  {groupId:'trip',revisionEventId:head,expenseEventId:h(exp),expenseAuthor:author,decision:'approve'},
  [['e',h(exp)],['p',author]])
const settlement=(head,id,sec,from,to,amount)=>ev(9001,from,head,id,sec,
  {id:`pay${id}`,from,to,amount,method:'manual'},[['p',to],['i',head===R0?h(1):h(10)]])
const confirmation=(head,id,sec,from,to,amount,settlementId)=>ev(9002,to,head,id,sec,
  {settlementEventId:h(settlementId),from,to,amount},
  [['p',from],['e',h(settlementId)],['i',head===R0?h(1):h(10)]])
const dataset=()=>[
  accept(R0,1,2), expense(R0,2,5,A,101), approval(R0,3,6,B,2,A),
  settlement(R0,4,10,B,A,20), confirmation(R0,5,11,B,A,20,4),
  accept(R1,10,73), expense(R1,11,80,B,20), approval(R1,12,81,A,11,B),
]

test('observed signed history carries old members and satoshi rounding across revisions',()=>{
  const events=dataset().reverse()
  const result=replayHistoricalFinancialEvents(group(),events)
  assert.equal(result.status,'observed')
  assert.deepEqual(result.observedNet,{[A]:20,[B]:-20,[C]:0})
  assert.equal(result.revisions.length,2)
  assert.deepEqual(result.revisions.map(r=>r.approvedExpenses),[1,1])
  assert.equal(result.safeForPayments,false)
})
test('unapproved expense cannot appear as a payable historic balance',()=>{
  const result=replayHistoricalFinancialEvents(group(),dataset().filter(x=>x.id!==h(3)))
  assert.equal(result.status,'incomplete')
  assert.equal(result.observedNet,null)
})
test('missing acceptance receipts prevent treating old payments as verified',()=>{
  const list=dataset().filter(x=>x.id!==h(1))
  assert.equal(replayHistoricalFinancialEvents(group(),list).status,'incomplete')
  assert.equal(replayHistoricalFinancialEvents(group(),list).observedNet,null)
})
test('unconfirmed historic payment remains unresolved and does not reduce debts',()=>{
  const result=replayHistoricalFinancialEvents(group(),dataset().filter(x=>x.id!==h(5)))
  assert.equal(result.status,'incomplete')
  assert.equal(result.observedNet,null)
  assert.equal(result.revisions[0].pendingPayments,1)
})
test('cross-author address collision and revision time mismatch fail closed',()=>{
  const source=dataset()
  const wrong={...source[1],tags:source[1].tags.map(t=>t[0]==='a'?['a',`30001:${C}:trip`]:t)}
  assert.equal(replayHistoricalFinancialEvents(group(),[wrong]).status,'conflict')
  assert.equal(replayHistoricalFinancialEvents(group(),[{...source[1],created_at:T+170}]).status,'conflict')
})
test('duplicate signed events are idempotent, divergent envelopes are conflicts',()=>{
  const list=dataset()
  const result=replayHistoricalFinancialEvents(group(),[...list,list[1]])
  assert.equal(result.status,'observed')
  const changed={...list[1],content:JSON.stringify({altered:true})}
  assert.equal(replayHistoricalFinancialEvents(group(),[...list,changed]).status,'conflict')
})
test('signed conflicting approvals never produce an observed total',()=>{
  const list=dataset()
  list.push(approval(R0,13,7,B,2,A))
  assert.equal(replayHistoricalFinancialEvents(group(),list).status,'conflict')
})
test('legacy historical groups stay unsupported instead of pretending debts vanished',()=>{
  const g=group();delete g._revisions[0].expensePolicy
  assert.equal(replayHistoricalFinancialEvents(g,dataset()).status,'unsupported')
})
test('bounded event collector rejects corrupt data and overflow without eviction',()=>{
  const list=dataset(), first=appendHistoricalReplayEvent([],list[0])
  assert.equal(first.added,true)
  assert.equal(appendHistoricalReplayEvent(first.events,list[0]).added,false)
  const corrupt=appendHistoricalReplayEvent(first.events,{...list[0],content:'changed'})
  assert.equal(corrupt.overflow,true)
  assert.equal(appendHistoricalReplayEvent(null,list[0]).overflow,true)
  const max=Array.from({length:MAX_HISTORICAL_REPLAY_EVENTS},(_,i)=>({...list[0],id:h(1000+i)}))
  assert.equal(appendHistoricalReplayEvent(max,list[1]).overflow,true)
  assert.equal(appendHistoricalReplayEvent(max,list[1]).events.length,MAX_HISTORICAL_REPLAY_EVENTS)
})
test('signed dispute is not silently converted into debt',()=>{
  const list=dataset()
  const i=list.findIndex(x=>x.id===h(3))
  list[i]={...list[i],content:JSON.stringify({groupId:'trip',revisionEventId:R0,expenseEventId:h(2),expenseAuthor:A,decision:'dispute'})}
  assert.equal(replayHistoricalFinancialEvents(group(),list).status,'incomplete')
  assert.equal(replayHistoricalFinancialEvents(group(),list).safeForPayments,false)
})

test('unanimous cancellation of an old disputed expense adds no historical debt',()=>{
  const raw=dataset().filter(e=>![2,3,4,5].includes(parseInt(e.id,16)))
  // Keep the invitation, add a disputed original and its two cancellation signatures.
  const proposal=expense(R0,21,5,A,400)
  const dispute=ev(9593,B,R0,22,6,
    {groupId:'trip',revisionEventId:R0,expenseEventId:h(21),expenseAuthor:A,decision:'dispute'},
    [['e',h(21)],['p',A]])
  const cancellation=(author,id)=>ev(9594,author,R0,id,8,
    {groupId:'trip',revisionEventId:R0,expenseEventId:h(21),expenseAuthor:A,action:'cancel'},
    [['e',h(21)],['p',A]])
  const result=replayHistoricalFinancialEvents(group(), [...raw,proposal,dispute,cancellation(A,23),cancellation(B,24)])
  assert.equal(result.status,'observed')
  assert.equal(result.observedNet[A],-10)
  assert.equal(result.observedNet[B],10)
})

test('unexpected historical kind and missing referenced proposal remain fail-closed',()=>{
  const list=dataset()
  assert.equal(replayHistoricalFinancialEvents(group(), [...list, {...list[0],kind:12345,id:h(201)}]).status,'conflict')
  const missing=dataset().filter(x=>x.id!==h(2))
  assert.equal(replayHistoricalFinancialEvents(group(),missing).status,'incomplete')
  assert.equal(replayHistoricalFinancialEvents(group(),missing).safeForPayments,false)
})
