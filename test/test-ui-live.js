'use strict'
// Live read-only UI integration against real WebHelm Chrome. Mock controller;
// never sends WeChat messages or edits real WeChat-bro files.
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const os=require('node:os')
const {WebHelmBrowser,requestRuntime}=require('../src/cdp')
const {createManagementBridge}=require('../src/ui-bridge')
const uiSource=fs.readFileSync(path.join(__dirname,'../src/wechat-ui.js'),'utf8')
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-ui-live-'))
let browser=null
const calls=[]
const response=req=>{
  switch(req.action) {
    case 'catalog': return {
      contacts:['filehelper','licheng'],rooms:['testneo'],
      agents:[{name:'test-agent',type:'room'},{name:'orchestrator',type:'orchestrator'}],
      orchestrator:{contexts:[{context:'testneo',state:'watching',watching:true,mode:'assistant',agent:'test-agent'}]},
      daemon:{healthy:true},
    }
    case 'control': return {changed:true}
    case 'agent-read': return {name:req.name,source:'bundled default',revision:'rev1',
      content:'---\nname: test-agent\ntype: room\n---\nText'}
    case 'agent-save': return {source:'user override',revision:'rev2'}
    case 'document-read': return {revision:'doc1',content:'Rule 1'}
    case 'document-save': return {revision:'doc2'}
    default: throw Error('unexpected action '+req.action)
  }
}
;(async()=>{
  const before=await requestRuntime({op:'list'})
  assert.equal(before.sessions.filter(s=>s.workspace==='WeChat').length,0,
    'must not hijack an existing WeChat Group')
  browser=await WebHelmBrowser.open({url:'about:blank',dataDir:tmp})
  const page=browser.page
  const management = createManagementBridge({
    source:uiSource,
    controller:{async handle(req){calls.push(req);return response(req)}},
    isActive:target=>target===page,
  })
  await management.attach(page)
  async function trustedClick(id) {
    const point=await page.evaluate(id=>{
      const root=document.getElementById('wechat-bro-management').shadowRoot
      const element=root.getElementById(id)
      element.scrollIntoView({block:'center',inline:'center'})
      const rect=element.getBoundingClientRect()
      return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}
    },id)
    await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
    await page.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1})
    await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1})
  }
  await page.goto('https://wx.qq.com',{waitUntil:'domcontentloaded',timeout:45000})
  await page.waitForFunction(()=>!!document.body,{timeout:25000})
  await management.mount(page)
  const mounted=await page.evaluate(()=>{
    const host=document.getElementById('wechat-bro-management')
    const root=host&&host.shadowRoot
    return {exists:!!host,button:!!(root&&root.getElementById('open')),
      panel:!!(root&&root.getElementById('panel'))}
  })
  assert.equal(mounted.exists,true)
  assert.equal(mounted.button,true)
  assert.equal(mounted.panel,true)
  // Synthetic DOM clicks must NOT trigger privileged operations.
  await page.evaluate(()=>{
    const root=document.getElementById('wechat-bro-management').shadowRoot
    root.getElementById('open').click()
  })
  assert.equal(calls.length,0,'untrusted script click cannot open admin UI')
  await trustedClick('open')
  await page.waitForFunction(()=>{
    const root=document.getElementById('wechat-bro-management').shadowRoot
    return root.getElementById('summary').textContent.includes('Orchestrator 已连接')
  },{timeout:15000})
  await page.evaluate(()=>{
    const root=document.getElementById('wechat-bro-management').shadowRoot
    root.getElementById('contacts').value='testneo'
    root.getElementById('contacts').dispatchEvent(new Event('change',{bubbles:true}))
  })
  await trustedClick('watch')
  await page.waitForFunction(()=>{
    const root=document.getElementById('wechat-bro-management').shadowRoot
    return root.getElementById('feedback').textContent.includes('已保存')
  },{timeout:15000})
  assert(calls.some(c=>c.action==='control'&&c.command==='watch'&&c.context==='testneo'&&c.mode==='assistant'))
  await page.evaluate(()=>{
    const root=document.getElementById('wechat-bro-management').shadowRoot
    root.querySelector('nav button[data-tab="agents"]').click()
  })
  await trustedClick('agent-load')
  await page.waitForFunction(()=>{
    const root=document.getElementById('wechat-bro-management').shadowRoot
    return root.getElementById('agent-text').value.includes('test-agent')
  },{timeout:15000})
  await page.evaluate(()=>{
    const root=document.getElementById('wechat-bro-management').shadowRoot
    root.getElementById('agent-text').value+=' edited'
  })
  await trustedClick('agent-save')
  await page.waitForFunction(()=>{
    const root=document.getElementById('wechat-bro-management').shadowRoot
    return root.getElementById('feedback').textContent.includes('Agent 已保存')
  },{timeout:15000})
  assert(calls.some(c=>c.action==='agent-save'&&c.content.includes('edited')))
  await page.evaluate(()=>{
    const root=document.getElementById('wechat-bro-management').shadowRoot
    root.querySelector('nav button[data-tab="docs"]').click()
  })
  await trustedClick('doc-load')
  await page.waitForFunction(()=>{
    const root=document.getElementById('wechat-bro-management').shadowRoot
    return root.getElementById('doc-text').value==='Rule 1'
  },{timeout:15000})
  await page.evaluate(()=>{
    const root=document.getElementById('wechat-bro-management').shadowRoot
    root.getElementById('doc-text').value='Rule 2'
  })
  await trustedClick('doc-save')
  await page.waitForFunction(()=>{
    const root=document.getElementById('wechat-bro-management').shadowRoot
    return root.getElementById('feedback').textContent.includes('文档已保存')
  },{timeout:15000})
  assert(calls.some(c=>c.action==='document-save'&&c.content==='Rule 2'))
  await management.mount(page)
  const count=await page.evaluate(()=>document.querySelectorAll('#wechat-bro-management').length)
  assert.equal(count,1,'UI injection must be idempotent')
  console.log('Live WeChat UI: mount, catalog, watch, Agent save, Rules save, idempotence PASS')
})().catch(error=>{console.error(error.stack||error);process.exitCode=1})
.finally(async()=>{
  if(browser){try{await browser.close()}catch(error){console.error('cleanup',error.message);process.exitCode=1}}
  fs.rmSync(tmp,{recursive:true,force:true})
  const state=await requestRuntime({op:'list'})
  if(state.sessions.some(s=>s.workspace==='WeChat')){
    console.error('leaked WebHelm WeChat Session')
    process.exitCode=1
  }
})
