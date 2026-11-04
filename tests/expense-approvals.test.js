import test from 'node:test'
import assert from 'node:assert/strict'
import { EXPENSE_POLICY, expenseDecisionTags, parseExpenseDecisionEvent,
  expenseApprovalSummary, reconcileExpenseApprovals } from '../src/lib/expense-approvals.js'
import { KIND_EXPENSE_DECISION } from '../src/lib/constants.js'

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)
const R = '0'.repeat(64), EXP = '1'.repeat(64), APP = '2'.repeat(64)
const ts = Math.floor(Date.now()/1000) - 100
const group = {id:'trip',pubkey:A,members:[A,B,C],_revisionId:R,
  _expensePolicy:EXPENSE_POLICY,_revisionStatus:'verified'}
const expense = {id:'dinner',_eventId:EXP,_pubkey:A,paidBy:A,splits:[A,B],
  amount:600,description:'dinner',_signedAt:ts}
const decision=(member,choice='approve',id=APP)=>({id,member,decision:choice,
  expenseEventId:EXP,expenseAuthor:A,revisionEventId:R,createdAt:ts+1})
const event=(member,choice='approve',id=APP)=>({id,pubkey:member,kind:KIND_EXPENSE_DECISION,
  created_at:ts+1,tags:expenseDecisionTags(group,expense),
  content:JSON.stringify({groupId:'trip',expenseEventId:EXP,expenseAuthor:A,
    revisionEventId:R,decision:choice})})

test('only a member-signed, exact group/expense/revision decision parses',()=>{
  assert.deepEqual(parseExpenseDecisionEvent(event(B),group),decision(B))
  assert.equal(parseExpenseDecisionEvent(event('d'.repeat(64)),group),null)
  assert.equal(parseExpenseDecisionEvent({...event(B),tags:[...event(B).tags,['e',EXP]]},group),null)
  assert.equal(parseExpenseDecisionEvent({...event(B),tags:expenseDecisionTags({...group,_revisionId:'9'.repeat(64)},expense)},group),null)
  assert.equal(parseExpenseDecisionEvent({...event(B),content:'not json'},group),null)
})

test('a signed proposal implicitly approves only its involved author',()=>{
  assert.deepEqual(expenseApprovalSummary(group,expense,[]).pending,[B])
  assert.equal(expenseApprovalSummary(group,expense,[decision(B)]).status,'approved')
  const anotherPayer={...expense,paidBy:B,splits:[B,C]}
  assert.deepEqual(expenseApprovalSummary(group,anotherPayer,[]).pending,[B,C])
})

test('unapproved, disputed and conflicting proposals never affect the ledger',()=>{
  const base={...group,proposedExpenses:[expense],_expenseDecisions:[]}
  assert.deepEqual(reconcileExpenseApprovals(base).expenses,[])
  assert.deepEqual(reconcileExpenseApprovals({...base,_expenseDecisions:[decision(B)]}).expenses,[expense])
  const disputed=reconcileExpenseApprovals({...base,_expenseDecisions:[decision(B,'dispute')]})
  assert.equal(disputed._expenseReviewRequired,true)
  assert.deepEqual(disputed.expenses,[])
  assert.equal(reconcileExpenseApprovals({...base,_expenseDecisions:[decision(B),decision(B,'dispute','3'.repeat(64))]})._expenseReviewRequired,true)
})

test('unrelated decisions do not authorize the expense',()=>{
  const bad={...decision(B),expenseEventId:'4'.repeat(64)}
  assert.equal(expenseApprovalSummary(group,expense,[bad]).status,'pending')
  assert.equal(expenseApprovalSummary(group,expense,[{...decision(B),expenseAuthor:C}]).status,'conflict')
  assert.equal(expenseApprovalSummary(group,expense,[{...decision(B),createdAt:ts-1}]).status,'conflict')
})

test('legacy groups keep existing balances without requiring approvals',()=>{
  const old={...group,_expensePolicy:null,expenses:[expense]}
  assert.equal(expenseApprovalSummary(old,expense).status,'legacy')
  assert.equal(reconcileExpenseApprovals(old),old)
})
