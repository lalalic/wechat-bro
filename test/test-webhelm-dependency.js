'use strict'
const assert = require('node:assert/strict')
const { resolveEndpoint, versionAtLeast, MIN_WEBHELM_VERSION, wsBase } = require('../src/cdp')

const status = {ok:true, version:'1.0.24', managed_chrome:{
  endpoint:'http://127.0.0.1:9222',profile_dir:'/tmp/webhelm-owned-profile'},
  chrome_guard:{status:'healthy'}}
const mk = (state = status) => async payload => {
  if (payload.op === 'ping') return state
  if (payload.op === 'guard-check') return {ok:true,chrome_guard:{status:'healthy'}}
  throw Error('unexpected op: '+payload.op)
}
async function main() {
  assert.equal(wsBase("http://127.0.0.1:9222/"),"ws://127.0.0.1:9222")
  assert.equal(MIN_WEBHELM_VERSION,'1.0.1')
  for (const [v, expected] of [['1.0.0',false],['1.0.1',true],['1.0.24',true],
    ['1.1.0',true],['0.99.99',false],['bogus',false]]) {
    assert.equal(versionAtLeast(v), expected, v)
  }
  const connected = await resolveEndpoint({request: mk(), env:{}})
  assert.equal(connected.endpoint,'http://127.0.0.1:9222')
  assert.equal(connected.version,'1.0.24')
  await assert.rejects(resolveEndpoint({request: async()=>{throw Error('ENOENT')},env:{}}),
    /webhelm_unavailable: Session IPC not responding/)
  await assert.rejects(resolveEndpoint({request:mk({...status,version:'1.0.0'}),env:{}}),
    /older than required/)
  await assert.rejects(resolveEndpoint({request:mk({...status, managed_chrome:null}),env:{}}),
    /did not report a managed Chrome/)
  await assert.rejects(resolveEndpoint({request:mk(),env:{WEBHELM_CDP_ENDPOINT:'http://127.0.0.1:3333'}}),
    /differs from the WebHelm-owned Chrome/)
  let checked=0
  await resolveEndpoint({request:async payload=>{
    if (payload.op==='ping') return {...status,chrome_guard:{status:'degraded'}}
    if (payload.op==='guard-check'){checked++;return {ok:true,chrome_guard:{status:'healthy'}}}
    throw Error('unexpected')
  },env:{}})
  assert.equal(checked,1)
  await assert.rejects(resolveEndpoint({request:async payload=>{
    if(payload.op==='ping') return {...status,chrome_guard:{status:'degraded'}}
    if(payload.op==='guard-check') return {ok:false,chrome_guard:{status:'degraded'}}
  },env:{}}),/managed Chrome is degraded/)
  console.log('webhelm external dependency: version, IPC, guard, endpoint, failures PASSED')
}
main().catch(e=>{console.error(e.stack);process.exitCode=1})
