'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname,'../src/wechat-bro.js'),'utf8')
const calls = []
const context={window:{},document:{},console:{log:()=>{}}}
vm.runInNewContext(source, context, {timeout:1000})
const emit = context.window.WechatyBro.emit
assert.equal(typeof emit, 'function')
context.window.sendToPuppeteer=(event, data)=>calls.push(['legacy',event,data.id])
emit('message',{id:11})
assert.deepEqual(calls,[['legacy','message',11]])
context.window.sendToWebHelm=(event, data)=>calls.push(['webhelm',event,data.id])
emit('message',{id:22})
assert.deepEqual(calls[1],['webhelm','message',22])
delete context.window.sendToWebHelm
delete context.window.sendToPuppeteer
emit('message',{id:33})
assert.equal(calls.length,2)
console.log('browser-side event bridge: WebHelm preferred, legacy supported, optional binding PASSED')
