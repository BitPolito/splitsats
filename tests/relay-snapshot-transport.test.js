import test from 'node:test'
import assert from 'node:assert/strict'
import { RelayPool } from '../src/lib/relay-pool.js'
import { RelaySnapshotAudit } from '../src/lib/relay-snapshot-audit.js'

const A = 'a'.repeat(64)
const event = () => ({ id: 'e'.repeat(64), pubkey: A, kind: 9000,
  created_at: 100, content: '{}', tags: [], sig: 'f'.repeat(128) })
class FakeSocket {
  constructor(url) { this.url=url; this.readyState=0; this.sent=[] }
  open() { this.readyState=1; this.onopen?.() }
  receive(m) { this.onmessage?.({data:JSON.stringify(m)}) }
  send(s) {this.sent.push(JSON.parse(s))}
  close() {this.readyState=3; this.onclose?.()}
}
function harness() {
  const sockets = new Map()
  const pool = new RelayPool({ socketFactory: url => {
    const ws=new FakeSocket(url);sockets.set(url,ws);return ws
  }, verifyEvent: e => e.sig === 'f'.repeat(128), reconnectMaxMs:50000 })
  const urls=['wss://one.test','wss://two.test']
  urls.forEach(url=>{pool.connect(url);sockets.get(url).open()})
  const audit=new RelaySnapshotAudit(urls)
  const app=[]
  pool.subscribe({ id:'historical', filters:[{kinds:[9000]}],
    onEvent:e=>app.push(e.id),
    onRelayEvent:(e,url)=>audit.record(url,e),
    onRelayEose:url=>audit.eose(url),
    onRelayReset:(url,reason)=>audit.reset(url,reason),
  })
  return {pool,sockets,urls,audit,app}
}
test('per-relay callbacks observe duplicates while app event delivery stays deduplicated',t=>{
  const {pool,sockets,urls,audit,app}=harness();t.after(()=>pool.stop())
  sockets.get(urls[0]).receive(['EVENT','historical',event()])
  sockets.get(urls[1]).receive(['EVENT','historical',event()])
  assert.equal(app.length,1)
  assert.deepEqual(audit.report().relays.map(x=>x.eventCount),[1,1])
  sockets.get(urls[0]).receive(['EOSE','historical'])
  sockets.get(urls[1]).receive(['EOSE','historical'])
  assert.equal(audit.report().status,'matching-observed')
})
test('invalid signature never enters per-relay evidence collector',t=>{
  const {pool,sockets,urls,audit}=harness();t.after(()=>pool.stop())
  sockets.get(urls[0]).receive(['EVENT','historical',{...event(),sig:'bad'}])
  assert.equal(audit.report().relays[0].eventCount,0)
})
test('socket disconnect invalidates previous matching EOSE epoch',t=>{
  const {pool,sockets,urls,audit}=harness();t.after(()=>pool.stop())
  urls.forEach(url=>{sockets.get(url).receive(['EVENT','historical',event()]);sockets.get(url).receive(['EOSE','historical'])})
  assert.equal(audit.report().status,'matching-observed')
  sockets.get(urls[1]).close()
  assert.equal(audit.report().status,'pending')
  assert.equal(audit.report().relays[1].phase,'offline')
})
