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
async function selected() {
  return evaluate('(() => {'+
    'const root=document.getElementById("wechat-bro-management").shadowRoot;'+
    'const select=root.getElementById("contacts");'+
    'return {value:select.value,manual:root.getElementById("context").value,'+
    'label:root.getElementById("contacts-button").querySelector(".wb-value").textContent,'+
    'temp:[...select.options].filter(o=>o.dataset.wbCurrentTemp==="true").map(o=>o.value),'+
    'route:root.getElementById("route").value,mode:root.getElementById("mode").value};})()')
}
async function switchChat(id,name,room,expectedName=name) {
  await evaluate('(() => {'+
    'const id='+JSON.stringify(id)+',name='+JSON.stringify(name)+',room='+JSON.stringify(room)+';'+
    'window.__currentChatId=id;'+
    'window.__contacts[id]={UserName:id,NickName:name,getDisplayName:()=>name,isRoomContact:()=>room};'+
    'const title=document.querySelector(".title_wrap .title_name");'+
    'title.setAttribute("data-username",id);'+
    '(name.includes("<img")?title.innerHTML=name:title.textContent=name);'+
    'document.querySelector(".chat_item.active").setAttribute("data-username",id);'+
    'window.__watchChat?.();'+
  '})()')
  await waitFor('document.getElementById("wechat-bro-management").shadowRoot.getElementById("contacts").value==='+JSON.stringify(expectedName))
}
async function test() {
  await connect()
  await send('Page.enable')
  await evaluate('(() => {'+
    'const wrap=document.createElement("div");wrap.className="title_wrap";'+
    'const title=document.createElement("a");title.className="title_name";'+
    'title.setAttribute("data-username","@@testneo");title.textContent="testneo";'+
    'const members=document.createElement("span");members.className="members";members.textContent="(3)";'+
    'wrap.append(title,members);document.body.appendChild(wrap);'+
    'const active=document.createElement("div");active.className="chat_item active";'+
    'active.setAttribute("data-username","@@testneo");document.body.appendChild(active);'+
    'window.__currentChatId="@@testneo";'+
    'window.__contacts={'+
      '"@@testneo":{UserName:"@@testneo",NickName:"testneo",getDisplayName:()=>"testneo",isRoomContact:()=>true},'+
      '"@claire":{UserName:"@claire",NickName:"Claire",getDisplayName:()=>"Claire",isRoomContact:()=>false}};'+
    'window.angular={element:()=>({injector:()=>({get:n=>'+
      'n==="chatFactory"?{getCurrentUserName:()=>window.__currentChatId}:'+
      'n==="contactFactory"?{getContact:id=>window.__contacts[id]}:'+
      'n==="$rootScope"?{$watch:(fn,cb)=>{window.__watchChat=cb}}:null})})};'+
    'window.wechatBroUiBridge=(nonce,id,payload)=>{'+
      'const data=payload.action==="catalog"?'+
      '{contacts:["Claire","filehelper"],rooms:["testneo","🌹️MobileNet手机上网电视"],'+
        'agents:[{name:"agent-a",type:"contact"},{name:"agent-b",type:"room"}],'+
        'orchestrator:{contexts:[]},daemon:{healthy:true}}:{};'+
      'Promise.resolve().then(()=>window.__wechatBroUiResponse(id,{ok:true,data}))};'+
    '})()')
  let source=fs.readFileSync(path.join(__dirname,'../src/wechat-ui.js'),'utf8')
  source=source.replace(
    "if (location.origin !== 'https://wx.qq.com' || document.getElementById('wechat-bro-management')) return",
    "if (document.getElementById('wechat-bro-management')) return"
  )
  await evaluate(source.replace('__WB_UI_NONCE__','active-chat-test-nonce'))
  await click('#open')
  await waitFor('document.getElementById("wechat-bro-management").shadowRoot.getElementById("contacts").value==="testneo"')
  let value=await selected()
  assert.equal(value.value,'testneo')
  assert.equal(value.manual,'')
  assert.equal(value.label,'[群] testneo')
  console.log('initial group auto-select PASS',JSON.stringify(value))

  // Choosing a different contact in the AI panel is still possible.
  await click('#contacts-button')
  await click('#wb-menu button[role=option]:nth-child(2)')
  value=await selected()
  assert.equal(value.value,'Claire','manual choice allowed')
  await evaluate('document.querySelector(".title_wrap .members").textContent="(4)"')
  await new Promise(resolve=>setTimeout(resolve,160))
  assert.equal((await selected()).value,'Claire','member-count change is not a chat switch')

  // Reset to the original chat via a real pointer click, so the next
  // navigation must actively change the selected dropdown.
  await click('#contacts-button')
  await click('#wb-menu button[role=option]:nth-child(4)')
  assert.equal((await selected()).value,'testneo')

  await switchChat('@claire','Claire',false)
  value=await selected()
  assert.equal(value.value,'Claire')
  assert.equal(value.manual,'')
  assert.equal(value.route,'')
  assert.equal(value.mode,'maintainer')
  console.log('Angular/title change to Claire PASS',JSON.stringify(value))

  await switchChat('@@unknown','临时群',true)
  value=await selected()
  assert.equal(value.value,'临时群')
  assert.deepEqual(value.temp,['临时群'])
  assert.equal(value.label,'[群] 临时群')
  console.log('uncatalogued active group PASS',JSON.stringify(value))

  // The real MobileNet room's getDisplayName() contains two WeChat emoji
  // images; the daemon canonical name strips an invalid emoji codepoint and
  // keeps the rose. The UI MUST select the same routable name, not raw HTML.
  const emojiHtml = '<img class="emoji emoji1f339" text="rose_web" src="/spacer.gif" />' +
    '<img class="emoji emoji3320e3" text="_web" src="/spacer.gif" />' +
    '️MobileNet手机上网电视'
  const canonical = '🌹️MobileNet手机上网电视'
  await evaluate('window.WechatyBro={_userNameToName:{"@@mobile":'+JSON.stringify(canonical)+'}}')
  await switchChat('@@mobile', emojiHtml, true, canonical)
  value=await selected()
  assert.equal(value.value, canonical, 'correct canonical routing identity')
  assert.equal(value.label, '[群] ' + canonical, 'no HTML in dropdown')
  assert.deepEqual(value.temp, [], 'existing canonical room is used, not a duplicate')
  assert(!value.label.includes('<img'), 'raw img markup must not be displayed')
  console.log('MobileNet emoji HTML canonical map PASS', JSON.stringify(value))

  // Even if the cached name map is unavailable, use the exact same
  // cleanName normalizer as the daemon.
  await switchChat('@claire', 'Claire', false)
  await evaluate('delete window.WechatyBro')
  await switchChat('@@mobile', emojiHtml, true, canonical)
  value=await selected()
  assert.equal(value.value, canonical)
  assert.equal(value.label, '[群] ' + canonical)
  assert.deepEqual(value.temp, [])
  console.log('MobileNet emoji HTML fallback normalization PASS')

  await switchChat('@@testneo','testneo',true)
  value=await selected()
  assert.equal(value.value,'testneo')
  assert.deepEqual(value.temp,[])
  assert.equal(value.label,'[群] testneo')
  await click('#close')
  await evaluate('(() => {const r=document.getElementById("wechat-bro-management").shadowRoot;'+
    'r.getElementById("contacts").value="Claire";'+
    'r.getElementById("context").value="manual";})()')
  await click('#open')
  await waitFor('(() => {const r=document.getElementById("wechat-bro-management").shadowRoot;'+
    'return r.getElementById("contacts").value==="testneo"&&r.getElementById("context").value===""})()')
  assert.equal((await selected()).label,'[群] testneo')
  console.log('reopen restores current chat PASS')

  console.log('Active chat auto-selection: current model, title, member count, uncatalogued, reopen PASS')
}

test().catch(error=>{console.error(error.stack || error);process.exitCode=1})
.finally(async()=>{
  try {socket?.close()} catch {}
  if(target?.id)try{await fetch(host+'/json/close/'+target.id)}catch{}
})
