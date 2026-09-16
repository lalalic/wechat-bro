/**
 * test-watch-control.js — focused coverage for runtime watch controls:
 * persistent watch edits, runtime pause gates, continuation suppression,
 * status visibility, and the daemon-to-orchestrator relay.
 *
 * Runs offline with a temporary data directory.
 */

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const WebSocket = require('ws')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bro-watch-control-'))
process.env.WECHAT_BRO_DATA_DIR = tmpDir

const m = require('../src/orchestrator.js')
const wsServer = require('../src/ws-server.js')

let pass = 0
let fail = 0
function ok(condition, name) {
  if (condition) { pass++; console.log(`  ok - ${name}`) }
  else { fail++; console.error(`  NOT OK - ${name}`) }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function writeAgent(name, frontmatter, body = 'prompt body') {
  const file = path.join(tmpDir, 'agents', `${name}.agent.md`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `---\n${frontmatter}\n---\n${body}\n`)
  return file
}

async function main() {
  console.log('# persistent watch config')
  const teamPath = writeAgent('wechat-team', 'name: wechat-team\ncontacts: [Bob, "Alice Chen"]\n# preserved comment', 'custom prompt')
  let agents = m.loadAgents()
  const team = agents.find(agent => agent.data.name === 'wechat-team')
  agents = m.applyPersistentWatch(agents, 'Carol', team, true)
  const rawTeam = fs.readFileSync(teamPath, 'utf8')
  ok(agents.find(agent => agent.data.name === 'wechat-team').data.contacts.includes('Carol'), 'watch adds the context to the assigned agent')
  ok(rawTeam.includes('# preserved comment') && rawTeam.includes('custom prompt'), 'watch preserves frontmatter comments and prompt body')
  ok(m.watchList(agents).has('Carol'), 'configured watch list includes the new context')

  const assistantPath = writeAgent('wechat-assistant', 'name: wechat-assistant\ntype: contact\ncontacts-assistant: [Dana]')
  agents = m.loadAgents()
  const assistant = agents.find(agent => agent.data.name === 'wechat-assistant')
  m.updateAgentWatchConfig(assistant, 'Dana', true)
  const assistantData = m.parseFrontmatter(fs.readFileSync(assistantPath, 'utf8')).data
  ok(!assistantData['contacts-assistant'] && assistantData.contacts.includes('Dana'), 'plain watch moves an assistant contact to maintainer mode')

  agents = m.loadAgents()
  const teamAgain = agents.find(agent => agent.data.name === 'wechat-team')
  agents = m.applyPersistentWatch(agents, 'Mode Test', teamAgain, true, 'assistant')
  const modeData = m.parseFrontmatter(fs.readFileSync(teamPath, 'utf8')).data
  ok(modeData['contacts-assistant'].includes('Mode Test') && !modeData.contacts.includes('Mode Test'), 'assistant mode writes contacts-assistant only')


  const controls = new m.WatchControlManager({ agents: m.loadAgents(), port: 9999 })
  ok(controls.contextStates().some(item => item.context === 'Carol' && item.configured && item.watching && !item.paused && !item.resident), 'status distinguishes configured and watching state')

  console.log('# runtime watch commands')
  const explicit = await controls.handle('watch', 'Agent Mode', { isRoom: false, agentName: 'wechat-team', mode: 'assistant' })
  ok(explicit.agent === 'wechat-team' && explicit.mode === 'assistant', 'watch accepts optional agent and assistant mode')
  let invalidMode = null
  try { await controls.handle('watch', 'Bad Mode', { isRoom: false, mode: 'wrong' }) } catch (error) { invalidMode = error }
  ok(invalidMode && /maintainer or assistant/.test(invalidMode.message), 'watch rejects invalid mode')

  await controls.handle('watch', 'Eve', { isRoom: false })
  const firstWatch = await controls.handle('watch', 'Eve', { isRoom: false })
  ok(firstWatch.changed === false, 'watch is idempotent')
  await controls.handle('pause', 'Eve', { state: 'on' })
  const secondPause = await controls.handle('pause', 'Eve', { state: 'on' })
  ok(secondPause.changed === false, 'pause is idempotent')
  ok(controls.isWatched('Eve') && controls.isPaused('Eve'), 'pause remains watched but blocks runtime')
  ok(!controls.canDispatch('Eve', 'start'), 'paused context cannot start a worker')
  await controls.handle('pause', 'Eve', { state: 'off' })
  const secondResume = await controls.handle('pause', 'Eve', { state: 'off' })
  ok(secondResume.changed === false, 'pause off is idempotent')
  ok(controls.canDispatch('Eve', 'start'), 'pause off restores dispatch')
  const unwatch = await controls.handle('unwatch', 'Eve')
  const secondUnwatch = await controls.handle('unwatch', 'Eve')
  ok(unwatch.changed === true && secondUnwatch.changed === false, 'unwatch is idempotent')
  ok(!controls.isWatched('Eve') && !controls.isPaused('Eve'), 'unwatch removes runtime state')

  console.log('# configured/runtime mismatch')
  controls.runtimeWatches.add('Frank')
  controls.paused.add('Grace')
  const states = controls.contextStates()
  ok(states.find(item => item.context === 'Frank').mismatch, 'runtime-only watch is visible as a mismatch')
  ok(states.find(item => item.context === 'Grace').paused, 'runtime-only pause is visible in status')

  console.log('# dispatcher gates')
  const accessorDispatch = m.makeDispatcher({ wsSend: async () => {} })
  ok(typeof accessorDispatch.taskStates === 'function' && typeof accessorDispatch.queues === 'function', 'dispatcher exposes status metadata accessors')
  ok(typeof accessorDispatch.taskStates() === 'object' && typeof accessorDispatch.queues() === 'object', 'richer status can call dispatcher metadata accessors')

  const dispatchDir = path.join(tmpDir, 'dispatch')
  fs.mkdirSync(dispatchDir, { recursive: true })
  const agentPath = writeAgent('wechat-dispatch', 'name: wechat-dispatch\ncontacts: [Paused]')
  const pausedAgent = { path: agentPath, data: { name: 'wechat-dispatch', type: 'contact', cwd: dispatchDir, harness: 'false' } }
  const pausedDispatch = m.makeDispatcher({ wsSend: async () => {}, canDispatch: () => false })
  const skipped = await pausedDispatch(pausedAgent, { from: 'Paused', to: 'me', type: 'text', Content: 'hi' }, null, {}, 'Paused')
  ok(skipped.skipped === true && skipped.reason === 'watch-control', 'dispatcher rejects an unwatched/paused task before starting')
  ok(fs.readdirSync(dispatchDir).filter(name => name.startsWith('.task-')).length === 0, 'rejected dispatch does not create a task file')

  const blockedDir = path.join(tmpDir, 'blocked-dispatch')
  const blockedAgentPath = writeAgent('wechat-blocked', 'name: wechat-blocked\ncontacts: [Blocked]\nnotify: true')
  const blockedNotifications = []
  const blockedDispatch = m.makeDispatcher({
    wsSend: async request => blockedNotifications.push(request),
    canDispatch: () => false,
  })
  const blockedResult = await blockedDispatch(
    { path: blockedAgentPath, data: { name: 'wechat-blocked', type: 'contact', cwd: blockedDir, notify: 'true', harness: 'false' } },
    { from: 'Blocked', to: 'me', type: 'text', Content: 'hi' },
    null, {}, 'Blocked',
  )
  ok(blockedResult.skipped === true && !fs.existsSync(blockedDir), 'blocked enqueue creates no cwd/session directories or AGENTS.md')
  ok(blockedNotifications.length === 0, 'blocked enqueue sends no receipt notification')

  const deferredDir = path.join(tmpDir, 'deferred-dispatch')
  const deferredAgentPath = writeAgent('wechat-deferred', 'name: wechat-deferred\ncontacts: [Deferred]')
  let gateOpen = true
  const deferredDispatch = m.makeDispatcher({
    wsSend: async () => {},
    canDispatch: (context, phase) => phase === 'enqueue' || gateOpen,
  })
  const deferredAgent = {
    path: deferredAgentPath,
    data: { name: 'wechat-deferred', type: 'contact', cwd: deferredDir, harness: 'sleep 0.12; printf %s \'{"status":"addressed"}\'' },
  }
  const firstDeferred = deferredDispatch(deferredAgent, { from: 'Deferred', to: 'me', type: 'text', Content: 'first' }, null, {}, 'Deferred')
  await sleep(35)
  ok(deferredDispatch.taskStates().Deferred.active === 1 && deferredDispatch.taskStates().Deferred.queued === 0, 'active task is reflected in dispatcher status')
  gateOpen = false
  const secondDeferred = deferredDispatch(
    { ...deferredAgent, data: { ...deferredAgent.data, harness: 'printf %s > blocked-worker-marker' } },
    { from: 'Deferred', to: 'me', type: 'text', Content: 'second' },
    null, {}, 'Deferred',
  )
  ok(deferredDispatch.taskStates().Deferred.queued === 1, 'accepted task is queued before its start gate')
  const [firstResult, secondResult] = await Promise.all([firstDeferred, secondDeferred])
  ok(secondResult.skipped && secondResult.reason === 'watch-control', 'task accepted at enqueue is blocked before start')
  ok(!deferredDispatch.taskStates().Deferred, 'queued accounting is removed after an accepted task is blocked')
  ok(Object.values(deferredDispatch.queues()).every(queue => queue.queued === 0), 'queue accounting has no stale queued count')
  ok(!fs.existsSync(path.join(deferredDir, 'blocked-worker-marker')), 'blocked queued task does not spawn its harness')
  ok(fs.readdirSync(deferredDir).filter(name => name.startsWith('.task-')).length === 0, 'blocked queued task leaves no task file')

  const continuationDir = path.join(tmpDir, 'continuation')
  fs.mkdirSync(continuationDir, { recursive: true })
  const continuationPath = writeAgent('wechat-continuation', 'name: wechat-continuation\ncontacts: [Continued]')
  const continuationAgent = {
    path: continuationPath,
    data: {
      name: 'wechat-continuation',
      type: 'contact',
      cwd: continuationDir,
      harness: `printf '%s' ${JSON.stringify('{"status":"addressed","next_action":{"type":"wake","after_seconds":30,"reason":"later"}}')}`,
    },
  }
  const continuationWakes = new m.WakeScheduler({
    dir: continuationDir,
    minSeconds: 0.01,
    maxSeconds: 60,
    maxOverdueSeconds: 60,
    dispatchWake: () => {},
  })
  const phases = []
  const gatedDispatch = m.makeDispatcher({
    wsSend: async () => {},
    wakes: continuationWakes,
    canDispatch: (context, phase) => {
      phases.push(phase)
      return phase !== 'continuation'
    },
  })
  const continuationResult = await gatedDispatch(
    continuationAgent,
    { from: 'Continued', to: 'me', type: 'text', Content: 'hi' },
    null, {}, 'Continued',
  )
  ok(phases.includes('start') && phases.includes('continuation'), 'dispatcher checks controls at start and continuation')
  ok(continuationResult.skipped === true && continuationWakes.list().length === 0, 'pause/unwatch suppresses a completed worker continuation')
  continuationWakes.stop()

  console.log('# daemon relay')
  const relay = wsServer.create({ port: 0, quiet: true })
  await relay.ready
  const port = relay.server.address().port
  const client = new WebSocket(`ws://localhost:${port}`)
  const worker = new WebSocket(`ws://localhost:${port}`)
  await Promise.all([
    new Promise(resolve => client.once('open', resolve)),
    new Promise(resolve => worker.once('open', resolve)),
  ])
  const relayResponse = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('relay timed out')), 2000)
    worker.on('message', raw => {
      const msg = JSON.parse(raw.toString())
      if (msg.event === 'orchestrator-request') {
        worker.send(JSON.stringify({
          cmd: 'orchestrator-response',
          id: 'worker-ack',
          requestId: msg.data.requestId,
          ok: true,
          data: { state: 'paused' },
        }))
      } else if (msg.id === 'worker-ack') {
        clearTimeout(timeout)
        resolve(msg)
      }
    })
  })
  const clientResponse = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('client timed out')), 2000)
    client.on('message', raw => {
      const msg = JSON.parse(raw.toString())
      if (msg.id === 'cli-cmd') {
        clearTimeout(timeout)
        resolve(msg)
      }
    })
  })
  client.send(JSON.stringify({ cmd: 'pause', context: 'Alice', state: 'on', id: 'cli-cmd' }))
  const clientResult = await clientResponse
  const workerAck = await relayResponse
  ok(clientResult.ok && clientResult.data.state === 'paused', 'daemon relay delivers an orchestrator control result')
  ok(workerAck.ok && workerAck.data.delivered, 'relay acknowledges the orchestrator response')
  client.close()
  worker.close()
  relay.close()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
