'use strict'
// Offline CDP protocol tests; WEBHELM_E2E=1 adds a real Chrome Session test.
// No WeChat login or message sends.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const WebSocket = require('ws')
const { CdpConnection, CdpPage, WebHelmBrowser, serializeArgs, requestRuntime } = require('../src/cdp')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function offline() {
  assert.equal(serializeArgs([undefined, { x: 5 }, false]), 'undefined,{"x":5},false')
  const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  const url = 'ws://127.0.0.1:' + server.address().port
  server.on('connection', (ws) => {
    ws.on('message', (data) => {
      const { id, method } = JSON.parse(data)
      const result = method === 'Page.getFrameTree'
        ? { frameTree: { frame: { url: 'about:blank' } } }
        : method === 'Runtime.evaluate'
          ? { result: { type: 'number', value: 42 } }
          : { done: true }
      ws.send(JSON.stringify({ id, result }))
    })
  })
  let conn
  try {
    conn = await CdpConnection.connect(url)
    assert.deepEqual(await conn.send('Test.echo'), { done: true })
    const page = new CdpPage(conn)
    await page.init()
    assert.equal(page.url(), 'about:blank')
    let observed
    await page.exposeFunction('testBridge', (event, payload) => { observed = [event, payload] })
    // Deliver a real CDP binding event over the socket, not through method mocks.
    for (const client of server.clients) client.send(JSON.stringify({
      method: 'Runtime.bindingCalled', params: {
        name: '__wb_testBridge', payload: JSON.stringify(['message', { id: 11 }])
      }
    }))
    await sleep(30)
    assert.deepEqual(observed, ['message', { id: 11 }])
    assert.equal(await page.evaluate(() => 6 * 7), 42)
    console.log('CDP offline: commands, evaluation and Runtime.addBinding event passed')
  } finally {
    if (conn) conn.close()
    for (const ws of server.clients) ws.terminate()
    await new Promise((resolve) => server.close(resolve))
  }
}

async function live() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bro-cdp-e2e-'))
  let browser
  try {
    browser = await WebHelmBrowser.open({ url: 'about:blank', dataDir: tmp })
    const { page } = browser
    const status = await requestRuntime({ op: 'list' })
    assert(status.sessions.some((s) => s.session_id === browser.sessionId && s.workspace === 'WeChat'))
    assert.equal(await page.evaluate(() => 6 * 7), 42)
    let events = []
    await page.exposeFunction('testBridge', (event, data) => events.push({ event, data }))
    await page.evaluate(() => window.testBridge('started', { id: 1 }))
    await sleep(100)
    assert.deepEqual(events[0], { event: 'started', data: { id: 1 } })
    await page.goto('data:text/html,<title>WebHelm-Test</title><p id="test">yes</p>')
    assert.equal(await page.evaluate(() => document.title), 'WebHelm-Test')
    await page.evaluate(() => window.testBridge('after-nav', { id: 2 }))
    await sleep(100)
    assert.deepEqual(events[1], { event: 'after-nav', data: { id: 2 } })
    console.log('CDP live: WeChat group lease, navigation, binding replay and event receive passed')
  } finally {
    if (browser) {
      const sid = browser.sessionId
      await browser.close()
      const state = await requestRuntime({ op: 'list' })
      assert(!state.sessions.some((s) => s.session_id === sid), 'Session must release its lease')
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
;(async () => {
  await offline()
  if (process.env.WEBHELM_E2E === '1') await live()
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
