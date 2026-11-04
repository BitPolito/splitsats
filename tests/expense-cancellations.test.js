import test from 'node:test'
import assert from 'node:assert/strict'
import { KIND_EXPENSE_CANCELLATION } from '../src/lib/constants.js'
import { reconcileExpenseApprovals } from '../src/lib/expense-approvals.js'
import { cancellationParticipants, expenseCancellationTags,
  parseExpenseCancellationEvent, expenseCancellationSummary } from '../src/lib/expense-cancellations.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)
const R = '1'.repeat(64), E = '2'.repeat(64)
const ts = Math.floor(Date.now()/1000)-200
const group = { id: 'trip', pubkey: A, _revisionId: R,
  _revisionStatus: 'verified', _expensePolicy: 'unanimous-expense-v1',
  members: [A,B,C], settlements: [], confirmations: [] }
const expense = { _eventId:E, _pubkey:A, paidBy:A, splits:[A,B], _signedAt:ts }
const event = (member=B, overrides={}) => ({ id:'3'.repeat(64), pubkey:member, kind:KIND_EXPENSE_CANCELLATION,
  created_at:ts+5, tags:expenseCancellationTags(group,expense),
  content:JSON.stringify({ groupId:'trip', revisionEventId:R, expenseEventId:E,
    expenseAuthor:A, action:'cancel' }), ...overrides })
const decision = (member, id) => ({ id, member, expenseEventId:E,
  expenseAuthor:A, revisionEventId:R, action:'cancel', createdAt:ts+5 })

test('cancellation is restricted to signed member, group, revision and expense',()=>{
  const e=event()
  assert.equal(parseExpenseCancellationEvent(e,group)?.member,B)
  assert.equal(parseExpenseCancellationEvent(event(C,{tags:[['e',E]]}),group),null)
  assert.equal(parseExpenseCancellationEvent(event(B,{pubkey:'f'.repeat(64)}),group),null)
  assert.equal(parseExpenseCancellationEvent(event(B,{content:'{}'}),group),null)
  assert.equal(parseExpenseCancellationEvent(event(B,{tags:[...e.tags,['e',E]]}),group),null)
  assert.equal(parseExpenseCancellationEvent(event(B,{created_at:-1}),group),null)
  assert.equal(parseExpenseCancellationEvent(event(B,{content:JSON.stringify({groupId:'trip',revisionEventId:R, expenseEventId:E,expenseAuthor:A,action:'approve'})}),group),null)
})

test('a disputed expense requires every payer, beneficiary and proposer',()=>{
  assert.deepEqual(cancellationParticipants({...expense,_pubkey:C}),[A,B,C])
  const a=decision(A,'4'.repeat(64)), b=decision(B,'5'.repeat(64))
  assert.equal(expenseCancellationSummary(group,expense,[], 'disputed').status,'none')
  assert.deepEqual(expenseCancellationSummary(group,expense,[a], 'disputed').pending,[B])
  const all=expenseCancellationSummary(group,expense,[a,b], 'disputed')
  assert.equal(all.status,'cancelled')
  assert.deepEqual(all.signed,[A,B])
})

test('approval conflict, absent dispute or any settlement cannot be released',()=>{
  const a=decision(A,'4'.repeat(64)), b=decision(B,'5'.repeat(64))
  assert.equal(expenseCancellationSummary(group,expense,[a,b],'approved').status,'blocked')
  assert.equal(expenseCancellationSummary(group,expense,[a,b],'conflict').status,'conflict')
  assert.equal(expenseCancellationSummary({...group,settlements:[{id:'paid'}]},expense,[a,b],'disputed').status,'blocked')
})

test('contradictory same-member cancellation stays a conflict',()=>{
  const a=decision(A,'4'.repeat(64)), b=decision(B,'5'.repeat(64))
  assert.equal(expenseCancellationSummary(group,expense,[a,{...a,id:'6'.repeat(64)},b],'disputed').status,'conflict')
  assert.equal(expenseCancellationSummary(group,expense,[{...a,revisionEventId:'f'.repeat(64)},b],'disputed').status,'conflict')
  assert.equal(expenseCancellationSummary(group,expense,[{...a,member:C},b],'disputed').status,'conflict')
})

test('unrelated cancellation does not affect another expense',()=>{
  const row={...decision(A,'4'.repeat(64)), expenseEventId:'6'.repeat(64)}
  assert.equal(expenseCancellationSummary(group,expense,[row],'disputed').status,'none')
})


test('replay keeps disputed original locked, then unanimous cancellation reopens without adding debt',()=>{
  const objection={ id:'9'.repeat(64), member:B, expenseEventId:E,
    expenseAuthor:A, revisionEventId:R, decision:'dispute', createdAt:ts+3 }
  let g=reconcileExpenseApprovals({...group, proposedExpenses:[expense], _expenseDecisions:[objection],
    _cancellationDecisions:[]})
  assert.equal(g._expenseReviewRequired,true)
  assert.deepEqual(g.expenses,[])
  g=reconcileExpenseApprovals({...g, _cancellationDecisions:[decision(A,'4'.repeat(64))]})
  assert.equal(g._expenseReviewRequired,true)
  g=reconcileExpenseApprovals({...g, _cancellationDecisions:[decision(A,'4'.repeat(64)),decision(B,'5'.repeat(64))]})
  assert.equal(g._expenseReviewRequired,false)
  assert.deepEqual(g.expenses,[])
  assert.equal(g.proposedExpenses.length,1)
  assert.equal(g._expenseDecisions.length,1)
})

test('old cancelled proposal never masquerades as the newly approved corrected expense',()=>{
  const objection={ id:'9'.repeat(64), member:B, expenseEventId:E,
    expenseAuthor:A, revisionEventId:R, decision:'dispute', createdAt:ts+3 }
  const replacement={ ...expense, _eventId:'7'.repeat(64), amount:200 }
  const approval={ id:'8'.repeat(64), member:B, expenseEventId:replacement._eventId,
    expenseAuthor:A, revisionEventId:R, decision:'approve', createdAt:ts+10 }
  const g=reconcileExpenseApprovals({...group, proposedExpenses:[expense,replacement],
    _expenseDecisions:[objection,approval],
    _cancellationDecisions:[decision(A,'4'.repeat(64)),decision(B,'5'.repeat(64))]})
  assert.equal(g._expenseReviewRequired,false)
  assert.deepEqual(g.expenses,[replacement])
})
