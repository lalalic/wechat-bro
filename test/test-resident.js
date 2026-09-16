'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PassThrough, Writable } = require('stream')
const { WatchControlManager, makeDispatcher, CodexResidentAdapter } = require('../src/orchestrator')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bro-resident-'))
const agentPath = path.join(tmp, 'agent.md')
fs.writeFileSync(agentPath, '---\nname: codex-agent\ntype: contact\ncontacts: [Alice]\nharness: codex\ncwd: ' + tmp + '\n---\nagent\n')
const agent = { path: agentPath, data: { name: 'codex-agent', type: 'contact', contacts: ['Alice'], harness: 'codex', cwd: tmp } }

async function main() {
  let paused = 0
  let closed = 0
  const controls = new WatchControlManager({ agents: [agent], applyWatch: agents => agents })
  controls.setHooks({ onPause: () => { paused++ }, onResidentOff: () => { closed++ }, onUnwatch: () => { closed++ } })

  const on = await controls.handle('resident', 'Alice', { state: 'on' })
  assert.strictEqual(on.state, 'resident')
  assert.strictEqual(controls.serialize().residentContexts[0], 'Alice')
  await controls.handle('pause', 'Alice', { state: 'on' })
  assert.strictEqual(paused, 1)
  await controls.handle('pause', 'Alice', { state: 'off' })
  await controls.handle('resident', 'Alice', { state: 'off' })
  assert.strictEqual(closed, 1)
  await controls.handle('unwatch', 'Alice')
  assert.strictEqual(closed, 2)
  await assert.rejects(() => controls.handle('unpause', 'Alice'), /unknown watch action/)

  const nonCodex = new WatchControlManager({ agents: [{ ...agent, data: { ...agent.data, harness: 'pi' } }] })
  await assert.rejects(() => nonCodex.handle('resident', 'Alice', { state: 'on' }), /requires the codex harness/)

  let factoryCalls = 0
  let runCalls = 0
  let cancelCalls = 0
  let closeCalls = 0
  const dispatcher = makeDispatcher({
    wsSend: async () => {},
    onEscalation: () => {},
    isResident: () => true,
    residentFactory: () => {
      factoryCalls++
      return {
        run: async () => { runCalls++; return { code: 0, stdout: '{"status":"addressed"}' } },
        cancel: async () => { cancelCalls++ },
        close: async () => { closeCalls++ },
      }
    },
  })
  const result = await dispatcher(agent, { from: 'Alice', to: 'me', Content: 'hello' }, null, { assistant: false }, 'Alice')
  assert.strictEqual(result.code, 0)
  assert.strictEqual(factoryCalls, 1)
  assert.strictEqual(runCalls, 1)
  assert.strictEqual(dispatcher.taskStates().Alice.worker, null)
  await dispatcher.cancelResident('Alice')
  await dispatcher.teardownResident('Alice')
  assert.strictEqual(cancelCalls, 1)
  assert.strictEqual(closeCalls, 1)

  const writes = []
  const stdout = new PassThrough()
  const fakeChild = new PassThrough()
  fakeChild.stdin = new Writable({
    write(chunk, encoding, callback) {
      const request = JSON.parse(chunk.toString())
      writes.push(request)
      if (request.id === 1) stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n')
      if (request.method === 'thread/start') stdout.write(JSON.stringify({ id: request.id, result: { threadId: 'thread-1' } }) + '\n')
      if (request.method === 'turn/start') {
        stdout.write(JSON.stringify({ id: request.id, result: { turnId: 'turn-1' } }) + '\n')
        stdout.write(JSON.stringify({ method: 'item/completed', params: { turnId: 'turn-1', item: { type: 'userMessage', content: [{ text: 'do not collect' }] } } }) + '\n')
        stdout.write(JSON.stringify({ method: 'item/completed', params: { turnId: 'turn-1', item: { type: 'agentMessage', text: '{"status":"addressed"}' } } }) + '\n')
        stdout.write(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'failed', error: 'provider failed' } } }) + '\n')
      }
      callback()
    },
  })
  fakeChild.stdout = stdout
  fakeChild.stderr = new PassThrough()
  const adapter = new CodexResidentAdapter({ spawnProcess: () => fakeChild, timeoutMs: 1000, requestTimeoutMs: 100 })
  const failedTurn = await adapter.run('Alice', { cwd: tmp, prompt: 'hello' })
  assert.strictEqual(failedTurn.code, 1)
  assert.strictEqual(failedTurn.stdout, '{"status":"addressed"}')
  assert.deepStrictEqual(writes.find(request => request.method === 'thread/start').params, {
    cwd: tmp,
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
  })
  assert.strictEqual(adapter.turns.size, 0)
  await adapter.closeAll()

  const timeoutChild = new PassThrough()
  timeoutChild.stdin = new Writable({ write(chunk, encoding, callback) { callback() } })
  timeoutChild.stdout = new PassThrough()
  timeoutChild.stderr = new PassThrough()
  const timeoutAdapter = new CodexResidentAdapter({ spawnProcess: () => timeoutChild, requestTimeoutMs: 10 })
  await assert.rejects(() => timeoutAdapter.start(), /request timed out: initialize/)

  console.log('resident tests passed')
}

main().catch(error => { console.error(error); process.exit(1) })
