import test from 'node:test'
import assert from 'node:assert/strict'
import { groupAddress } from '../src/lib/group-history.js'
import { mergeVerifiedGroup, mayApplyGroupTransaction } from '../src/lib/group-state.js'
import { canResumeAfterPriorHistory } from '../src/lib/prior-history-gate.js'

const A='a'.repeat(64), B='b'.repeat(64)
const REV='1'.repeat(64), NEXT='2'.repeat(64)
const group = () => ({ id:'trip', name:'Old', pubkey:A, members:[A,B],
  eventId:'e'.repeat(64), _groupCreatedAt:100, _revisionId:REV,
  _revisionStatus:'verified', _financialMigrationQuarantine:true,
  _financialNamespaceRisk:{reasons:['v2-financial-event-observed']},
  _financialReviewRequired:true, expenses:[],settlements:[],confirmations:[] })

test('same-head signed metadata cannot clear sticky financial quarantine',()=>{
  const old=group()
  const incoming={...old,eventId:'f'.repeat(64),_groupCreatedAt:110,name:'New'}
  const updated=mergeVerifiedGroup([old],incoming)[0]
  assert.equal(updated.name,'New')
  assert.equal(updated._financialMigrationQuarantine,true)
  assert.equal(updated._financialReviewRequired,true)
  assert.deepEqual(updated._financialNamespaceRisk.reasons,['v2-financial-event-observed'])
  assert.equal(mayApplyGroupTransaction([updated],groupAddress(updated),{_legacyUnscoped:false}),false)
})

test('new signed head starts pending without inheriting present-head quarantine',()=>{
  const old=group()
  const incoming={...old,eventId:'f'.repeat(64),_groupCreatedAt:110,_revisionId:NEXT}
  const updated=mergeVerifiedGroup([old],incoming)[0]
  assert.equal(updated._revisionStatus,'pending')
  assert.equal(updated._financialMigrationQuarantine,false)
  assert.equal(updated._financialHistoryChecked,false)
  assert.equal(updated._financialNamespaceRisk,null)
})

test('membership-history completion cannot release a quarantined group',()=>{
  const g={...group(),_priorHistoryChecked:true,_historicalActivityDetected:false,
    _revisions:[{id:'0'.repeat(64),members:[A,B]},{id:REV,members:[A,B]}]}
  assert.equal(canResumeAfterPriorHistory(g,'verified'),false)
})
