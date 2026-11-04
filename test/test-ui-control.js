'use strict'
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {createUiController,revision}=require('../src/ui-control')
const {loadAgentFile}=require('../src/orchestrator')

;(async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-ui-controller-'))
  const pkg=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-ui-bundled-'))
  const defaultFile=path.join(pkg,'agent.md')
  const doc='---\nname: wechat-test\ntype: contact\nharness: codex\ncontacts: [testneo]\ndescription: Example\n---\n\nHello'
  fs.writeFileSync(defaultFile,doc)
  const userFile=path.join(tmp,'agents','wechat-test.agent.md')
  const calls=[]
  const send=async command=>{
    calls.push(command)
    if(command.cmd==='status')return {orchestrator:{contexts:[]},daemon:{healthy:true}}
    if(command.cmd==='contacts')return ['filehelper','licheng']
    if(command.cmd==='rooms')return ['testneo']
    return {action:command.cmd,context:command.context,changed:true}
  }
  const agents=()=>[loadAgentFile(fs.existsSync(userFile)?userFile:defaultFile)]
  const ui=createUiController({dataDir:tmp,send,agents})
  try {
    const catalog=await ui.handle({action:'catalog'})
    assert.deepEqual(catalog.contacts,['filehelper','licheng'])
    assert.deepEqual(catalog.rooms,['testneo'])
    assert.equal(catalog.agents.length,1)
    assert.equal(catalog.orchestrator.contexts.length,0)
    await ui.handle({action:'control',command:'watch',context:'testneo',mode:'assistant',agent:'wechat-test'})
    assert.deepEqual(calls.at(-1),{cmd:'watch',context:'testneo',mode:'assistant',agent:'wechat-test'})
    await ui.handle({action:'control',command:'pause',context:'testneo',state:'on'})
    assert.equal(calls.at(-1).state,'on')
    for(const action of [
      {action:'control',command:'exit',context:'testneo'},
      {action:'control',command:'watch',context:'filehelper',mode:'assistant'},
      {action:'control',command:'watch',context:'testneo',mode:'invalid'},
      {action:'document-read',scope:'arbitrary',kind:'rules'},
      {action:'document-save',scope:'global',kind:'cookies',content:'x',revision:revision('')},
      {action:'agent-read',name:'../../etc/passwd'},
    ]) await assert.rejects(ui.handle(action))
    let result=await ui.handle({action:'agent-read',name:'wechat-test'})
    assert.equal(result.source,'bundled default')
    assert.equal(result.content,doc)
    const next=doc.replace('Hello','Hello from UI')
    await assert.rejects(ui.handle({action:'agent-save',name:'wechat-test',content:next,revision:'old'}),/changed/)
    await assert.rejects(ui.handle({action:'agent-save',name:'wechat-test',content:next.replace('harness: codex','harness: pi'),revision:result.revision}),/read-only/)
    const saved=await ui.handle({action:'agent-save',name:'wechat-test',content:next,revision:result.revision})
    assert.equal(saved.source,'user override')
    assert.equal(fs.readFileSync(defaultFile,'utf8'),doc,'bundled default unchanged')
    assert.equal(fs.readFileSync(userFile,'utf8'),next)
    result=await ui.handle({action:'agent-read',name:'wechat-test'})
    assert.equal(result.source,'user override')
    assert.equal(result.content,next)
    await ui.handle({action:'agent-save',name:'wechat-test',content:next.replace('Hello from UI','Second edit'),revision:result.revision})
    assert.equal(fs.readFileSync(userFile,'utf8').includes('Second edit'),true,'edited existing user override')
    let rules=await ui.handle({action:'document-read',scope:'global',kind:'rules'})
    assert.equal(rules.content,'')
    await ui.handle({action:'document-save',scope:'global',kind:'rules',revision:rules.revision,content:'Global rule'})
    assert.equal(fs.readFileSync(path.join(tmp,'rules.md'),'utf8'),'Global rule')
    await assert.rejects(ui.handle({action:'document-save',scope:'global',kind:'rules',revision:rules.revision,content:'stale'}),/changed/)
    const contact={action:'document-read',scope:'contact',kind:'memory',context:'testneo'}
    const memory=await ui.handle(contact)
    await ui.handle({...contact,action:'document-save',revision:memory.revision,content:'Facts for testneo'})
    assert.equal(fs.readFileSync(path.join(tmp,'contacts','testneo','memory.md'),'utf8'),'Facts for testneo')
    assert.equal(fs.existsSync(path.join(tmp,'contacts','testneo','rules.md')),false)
    const sym=path.join(tmp,'contacts','elsewhere')
    fs.symlinkSync(pkg,sym)
    await assert.rejects(ui.handle({action:'document-save',scope:'contact',kind:'rules',context:'elsewhere',
      content:'unauthorized',revision:revision('')}),/symlink/)
    await assert.rejects(ui.handle({action:'document-save',scope:'global',kind:'rules',
      content:'x'.repeat(65537),revision:revision('Global rule')}),/64 KiB/)
    await assert.rejects(ui.handle({action:'document-save',scope:'global',kind:'rules',
      content:'中'.repeat(22000),revision:revision('Global rule')}),/64 KiB|too large/)
    console.log('UI controller: catalog, watch/control, bounded edits, defaults, revisions, symlink guard PASS')
  } finally {
    fs.rmSync(tmp,{recursive:true,force:true})
    fs.rmSync(pkg,{recursive:true,force:true})
  }
})().catch(e=>{console.error(e.stack||e);process.exitCode=1})
