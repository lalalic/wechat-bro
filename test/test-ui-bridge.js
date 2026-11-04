'use strict'
const assert=require('node:assert/strict')
const {createManagementBridge}=require('../src/ui-bridge')
const calls=[]
const responses=[]
let active
let address='https://wx.qq.com'
const page={
  closed:false,
  url:()=>address,
  async exposeFunction(name,handler){assert.equal(name,'wechatBroUiBridge');this.handler=handler},
  async evaluate(source,...args){
    if(typeof source==='string'){this.source=source;return true}
    responses.push(args)
  },
}
active=page
const controller={async handle(request){calls.push(request);return {handled:request.action}}}
const bridge=createManagementBridge({
  controller,source:"(function(){ const nonce = '__WB_UI_NONCE__'; })()",
  isActive:target=>target===active,
})
;(async()=>{
  await assert.rejects(bridge.mount(page),/attached before mount/)
  await bridge.attach(page)
  assert.equal(await bridge.mount(page),true)
  const secret=page.source.match(/[a-f0-9]{48}/)[0]
  assert.equal(secret.length,48)
  await page.handler('bad-token','u1',{action:'catalog'})
  assert.equal(calls.length,0,'invalid binding token cannot reach controller')
  assert.equal(responses.at(-1)[1].ok,false)
  await page.handler(secret,'u2',{action:'catalog'})
  assert.deepEqual(calls.at(-1),{action:'catalog'})
  assert.deepEqual(responses.at(-1)[1],{ok:true,data:{handled:'catalog'}})
  address='https://example.com'
  await page.handler(secret,'u3',{action:'agent-save'})
  assert.equal(calls.length,1,'navigation to non-WeChat origin revokes access')
  assert.equal(await bridge.mount(page),false)
  address='https://wx.qq.com'
  active={}
  await page.handler(secret,'u4',{action:'document-save'})
  assert.equal(calls.length,1,'stale page cannot mutate settings')
  active=page
  page.closed=true
  await page.handler(secret,'u5',{action:'agent-save'})
  assert.equal(calls.length,1,'closed page cannot mutate settings')
  console.log('UI bridge: nonce, origin, stale page, closed page, response isolation PASS')
})().catch(error=>{console.error(error.stack||error);process.exitCode=1})
