'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const host = 'http://127.0.0.1:9222'
let target, socket, sequence = 0
const requests = new Map()
async function connect() {
  const response = await fetch(host + '/json/new?about:blank', { method: 'PUT' })
  if (!response.ok) throw Error('Chrome target creation failed ' + response.status)
  target = await response.json()
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const pending = requests.get(message.id)
    if (!pending) return
    requests.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(Error(message.error.message))
    else pending.resolve(message.result)
  })
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => {
      requests.delete(id)
      reject(Error('CDP timeout ' + method))
    }, 8000)
    requests.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  })
  if (result.exceptionDetails) {
    throw Error('Browser JS: ' + (result.exceptionDetails.exception?.description ||
      result.exceptionDetails.text || 'unknown'))
  }
  return result.result?.value
}
async function click(selector) {
  const point = await evaluate('(() => { '+
    'const r=document.getElementById("wechat-bro-management").shadowRoot; '+
    'const e=r.querySelector('+JSON.stringify(selector)+'); '+
    'if(!e)throw Error("Missing '+selector+'"); '+
    'e.scrollIntoView({block:"nearest"}); '+
    'const x=e.getBoundingClientRect(); '+
    'return {x:x.left+x.width/2,y:x.top+x.height/2}; })()')
  await send('Input.dispatchMouseEvent', { type:'mouseMoved', ...point })
  await send('Input.dispatchMouseEvent', { type:'mousePressed', ...point, button:'left', clickCount:1 })
  await send('Input.dispatchMouseEvent', { type:'mouseReleased', ...point, button:'left', clickCount:1 })
}
async function waitFor(expression) {
  for (let i = 0; i < 45; i++) {
    if (await evaluate(expression)) return
    await new Promise(r=>setTimeout(r,100))
  }
  throw Error('Timed out waiting for: ' + expression)
}
async function test() {
  await connect()
  await send('Page.enable')
  await evaluate('(() => { window.wechatBroUiBridge = (nonce,id,payload) => { '+
    'const result=payload.action==="catalog" ? '+
      '{contacts:["filehelper","Claire","张三","WeChat Team","天津"],rooms:["testneo","长群名测试群组"],'+
      'agents:[{name:"wechat-orchestrator",type:"orchestrator"},'+
        '{name:"wechat-individual-maintainer",type:"contact"},'+
        '{name:"wechat-room-maintainer",type:"room"}],'+
      'orchestrator:{contexts:[]},daemon:{healthy:true}} : {revision:"dummy",content:"test"};'+
    'Promise.resolve().then(()=>window.__wechatBroUiResponse(id,{ok:true,data:result})) '+
    '} })()')
  let source = fs.readFileSync(path.join(__dirname,'../src/wechat-ui.js'),'utf8')
  source = source.replace(
    "if (location.origin !== 'https://wx.qq.com' || document.getElementById('wechat-bro-management')) return",
    "if (document.getElementById('wechat-bro-management')) return"
  )
  assert(source.includes('const menu = document.createElement'))
  await evaluate(source.replace('__WB_UI_NONCE__', 'isolated-test-nonce'))
  await click('#open')
  await waitFor('document.getElementById("wechat-bro-management").shadowRoot.getElementById("contacts").options.length >= 5')
  for (const [id,tab] of [
    ['contacts',null],['route',null],['mode',null],
    ['agent','agents'],['scope','docs'],['kind','docs']]) {
    if (tab) await click('nav button[data-tab='+tab+']')
    await click('#'+id+'-button')
    const geometry=await evaluate('(() => {'+
      'const root=document.getElementById("wechat-bro-management").shadowRoot;'+
      'const trigger=root.getElementById('+JSON.stringify(id+'-button')+');'+
      'const menu=root.getElementById("wb-menu");'+
      'const a=trigger.getBoundingClientRect(),b=menu.getBoundingClientRect();'+
      'const items=[...menu.querySelectorAll("button[role=option]")];'+
      'return {open:!menu.hidden,count:items.length,'+
        'font:parseFloat(getComputedStyle(menu).fontSize),'+
        'optionFont:parseFloat(getComputedStyle(items[0]).fontSize),'+
        'x:Math.round(b.left-a.left),menuWidth:b.width,triggerWidth:a.width,'+
        'height:b.height,top:b.top,bottom:b.bottom,viewportHeight:innerHeight,'+
        'nativeDisplay:getComputedStyle(root.getElementById('+JSON.stringify(id)+')).display};'+
      '})()')
    assert.equal(geometry.open,true,id+' popup open')
    assert(geometry.count>=2,id+' options')
    assert.equal(geometry.font,13,id+' popup font')
    assert.equal(geometry.optionFont,13,id+' option font')
    assert.equal(geometry.nativeDisplay,'none',id+' no native popup')
    assert(Math.abs(geometry.x)<4,id+' horizontal alignment '+JSON.stringify(geometry))
    assert(Math.abs(geometry.menuWidth-geometry.triggerWidth)<4,id+' menu width')
    assert(geometry.height<=259,id+' menu height')
    assert(geometry.top>=0 && geometry.bottom<=geometry.viewportHeight+1,id+' within viewport '+JSON.stringify(geometry))
    await click('#wb-menu button[role=option]:nth-child(2)')
    const value=await evaluate('(() => {'+
      'const root=document.getElementById("wechat-bro-management").shadowRoot;'+
      'return {native:root.getElementById('+JSON.stringify(id)+').value,'+
      'rendered:root.getElementById('+JSON.stringify(id+'-button')+').querySelector(".wb-value").textContent,'+
      'open:!root.getElementById("wb-menu").hidden};})()')
    assert(value.native!==undefined && value.rendered.length>0,id+' selection')
    assert.equal(value.open,false,id+' closes')
    console.log(id,'PASS',JSON.stringify({font:geometry.font,width:Math.round(geometry.menuWidth),count:geometry.count,value:value.native}))
  }
  console.log('Real Chrome custom select: 6/6 font, geometry, pointer selection PASS')
}
test().catch(error=>{console.error(error.stack || error);process.exitCode=1})
.finally(async()=>{
  try {socket?.close()} catch {}
  if(target?.id)try{await fetch(host+'/json/close/'+target.id)}catch{}
})
