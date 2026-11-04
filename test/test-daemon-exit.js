'use strict'
// Explicit opt-in live lifecycle check. Uses only the WeChat group, never
// writes messages or logs into WeChat and leaves other WebHelm sessions alone.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const WebSocket = require('ws')
const { requestRuntime } = require('../src/cdp')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-exit-e2e-'))
const port = String(process.env.WECHAT_EXIT_TEST_PORT || 19235)
const peers = 'filehelper,licheng,testneo'
let daemon = null
function sessionIds(list) { return list.sessions.filter(s => s.workspace !== 'WeChat').map(s => s.session_id).sort() }
async function status() { return requestRuntime({op:'list'}) }
async function verifyGone(otherIds) {
  const until = Date.now() + 20000
  while (Date.now() < until) {
    const sessions = await status()
    const wechat = sessions.sessions.filter(s => s.workspace === 'WeChat')
    const other = sessionIds(sessions)
    if (!wechat.length && JSON.stringify(other) === JSON.stringify(otherIds)) {
      const capacity = await requestRuntime({op:'capacity',workspace:'WeChat'})
      assert.equal(capacity.poolSize,null,'WeChat tab group must be destroyed')
      return
    }
    await sleep(150)
  }
  throw Error('WeChat group/session not destroyed on daemon exit')
}
function childExit(proc,ms=25000) {
  return new Promise((resolve,reject)=>{
    let done = false
    const timer=setTimeout(()=>{if(!done){done=true;reject(Error('daemon exit timeout'))}},ms)
    const finish=(code,signal)=>{if(!done){done=true;clearTimeout(timer);resolve({code,signal})}}
    if(proc.exitCode!==null || proc.signalCode!==null) return finish(proc.exitCode,proc.signalCode)
    proc.once('exit',finish)
  })
}
async function startDaemon() {
  const env={...process.env,WECHAT_BRO_DATA_DIR:dataDir,
    WECHAT_BRO_ALLOWED_RECIPIENTS:peers,WS_PORT:port,
    WECHAT_BRO_LOG:'1'}
  const proc=spawn(process.execPath,[path.join(__dirname,'../src/cli.js'),'--daemon','--quiet','--port',port],{
    cwd:path.join(__dirname,'..'),env,stdio:['ignore','pipe','pipe'],
  })
  daemon=proc
  let log=''
  for(const stream of [proc.stdout,proc.stderr]) stream.on('data',buf=>{log+=String(buf)})
  const until=Date.now()+45000
  while(Date.now()<until){
    if(proc.exitCode!==null) throw Error('daemon failed before ready: '+log.slice(-600))
    if(log.includes('Daemon ready')) return proc
    await sleep(200)
  }
  throw Error('daemon readiness timeout: '+log.slice(-600))
}
async function rpc(cmd) {
  const ws=new WebSocket('ws://127.0.0.1:'+port)
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)})
  return new Promise((resolve,reject)=>{
    const id='lifecycle-'+Date.now()
    const timer=setTimeout(()=>{ws.close();reject(Error('rpc timeout '+cmd))},5000)
    ws.on('message', raw=>{
      let m;try{m=JSON.parse(raw)}catch{return}
      if(m.id!==id)return
      clearTimeout(timer)
      ws.close()
      if(!m.ok)return reject(Error(cmd+': '+m.error))
      resolve(m.data)
    })
    ws.send(JSON.stringify({id,cmd}))
  })
}
;(async()=>{
  const before=await status()
  assert.equal(before.sessions.filter(s=>s.workspace==='WeChat').length,0,
    'WeChat group must be unused before live exit test')
  const unaffected=sessionIds(before)
  let proc=await startDaemon()
  assert.equal((await rpc('daemon-status')).lifecycle==='authenticated'||(await rpc('daemon-status')).lifecycle==='login_required',true)
  assert.equal((await status()).sessions.filter(s=>s.workspace==='WeChat').length,1)
  const exitPromise=childExit(proc)
  assert.equal((await rpc('exit')).shuttingDown,true)
  const result=await exitPromise
  assert.equal(result.code,0,'exit command should shut down cleanly')
  await verifyGone(unaffected)
  console.log('LIVE daemon exit: WeChat group destroyed; other groups unaffected')

  proc=await startDaemon()
  assert.equal((await status()).sessions.filter(s=>s.workspace==='WeChat').length,1)
  const termPromise=childExit(proc)
  proc.kill('SIGTERM')
  const terminated=await termPromise
  assert.equal(terminated.code,0,'SIGTERM should shut down cleanly')
  await verifyGone(unaffected)
  console.log('LIVE SIGTERM: WeChat group destroyed; other groups unaffected')
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1})
.finally(async()=>{
  if(daemon && daemon.exitCode===null && daemon.signalCode===null) {
    daemon.kill('SIGTERM')
    await childExit(daemon,15000).catch(()=>{})
  }
  fs.rmSync(dataDir,{recursive:true,force:true})
})
