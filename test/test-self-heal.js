'use strict'

// Offline fault-injection for real WebHelm pool-exhaustion seen after PM2 restart.
// Never touches a browser, a live Session, or PM2.
const assert = require('node:assert/strict')
const { startWechatSession } = require('../src/cdp')
const { maySpawnDaemonChild } = require('../src/orchestrator')

const EXHAUSTED = 'Workspace WeChat pool is exhausted at size 1'
const healthy = { session_id: 'new-session', target_id: 'new-target' }

function harness({ firstError = EXHAUSTED, capacity = { poolSize: 1, idle: 0, leased: 1 },
  sessions = [], secondError = null, cleanupError = null } = {}) {
  const operations = []
  let starts = 0
  const request = async payload => {
    operations.push(payload.op)
    if (payload.op === 'workspace-create') return { created: true }
    if (payload.op === 'start') {
      starts++
      if (starts === 1 && firstError) throw new Error(firstError)
      if (starts === 2 && secondError) throw new Error(secondError)
      return healthy
    }
    if (payload.op === 'capacity') return capacity
    if (payload.op === 'list') return { session_count: sessions.length, sessions }
    throw new Error('unexpected IPC call')
  }
  const cleaned = []
  const messages = []
  const cleanup = async args => {
    cleaned.push(args)
    if (cleanupError) throw new Error(cleanupError)
  }
  return { operations, cleaned, messages,
    start: () => startWechatSession({ url: 'about:blank', dataDir: '/tmp/wechat-test', allowOrphanRecovery: true, request, cleanup,
      report: message => messages.push(message) }) }
}

async function run() {
  const normal = harness({ firstError: null })
  assert.deepEqual(await normal.start(), healthy)
  assert.deepEqual(normal.operations, ['workspace-create', 'start'])
  assert.equal(normal.cleaned.length, 0)

  // The safety feature is opt-in: generic CDP test clients do not own port 9231.
  await assert.rejects(startWechatSession({ url: 'about:blank',
    request: async payload => {
      if (payload.op === 'start') throw new Error(EXHAUSTED)
      if (payload.op === 'workspace-create') return { created: true }
      throw new Error('must not inspect or delete anything')
    } }), new RegExp(EXHAUSTED))

  const orphan = harness()
  assert.deepEqual(await orphan.start(), healthy)
  assert.deepEqual(orphan.operations, ['workspace-create', 'start', 'capacity', 'list', 'workspace-create', 'start'])
  assert.deepEqual(orphan.cleaned, [{ dataDir: '/tmp/wechat-test' }])
  assert.match(orphan.messages[0], /removed orphaned/)

  const active = harness({ sessions: [{ workspace: 'WeChat', session_id: 'live' }] })
  await assert.rejects(active.start(), new RegExp(EXHAUSTED))
  assert.equal(active.cleaned.length, 0, 'must not destroy an active WeChat Session')

  const unknown = harness({ capacity: { poolSize: 1, idle: 0, leased: null } })
  await assert.rejects(unknown.start(), new RegExp(EXHAUSTED))
  assert.equal(unknown.cleaned.length, 0, 'uncertain ownership must fail closed')

  const unrelated = harness({ firstError: 'WebHelm IPC connection refused' })
  await assert.rejects(unrelated.start(), /connection refused/)
  assert.deepEqual(unrelated.operations, ['workspace-create', 'start'])
  assert.equal(unrelated.cleaned.length, 0)

  const oneRetry = harness({ secondError: EXHAUSTED })
  await assert.rejects(oneRetry.start(), new RegExp(EXHAUSTED))
  assert.equal(oneRetry.operations.filter(op => op === 'start').length, 2,
    'only one recovery retry, no infinite loop')
  assert.equal(oneRetry.cleaned.length, 1)

  const failedCleanup = harness({ cleanupError: 'cleanup failed' })
  await assert.rejects(failedCleanup.start(), /cleanup failed/)
  assert.equal(failedCleanup.operations.filter(op => op === 'start').length, 1)

  assert.equal(maySpawnDaemonChild({}), true, 'standalone orchestrator can own its child')
  assert.equal(maySpawnDaemonChild({ WECHAT_BRO_NO_DAEMON_SPAWN: '1' }), false)
  assert.equal(maySpawnDaemonChild({ PM2_HOME: '/any-pm2-home' }), false,
    'PM2 orchestrator must reconnect, never spawn another daemon')
  assert.equal(maySpawnDaemonChild({ PM2_HOME: '/pm2', WECHAT_BRO_NO_DAEMON_SPAWN: '0' }), false)
  console.log('Self-heal tests passed: normal, orphan, active, uncertain, unrelated, bounded retry, cleanup failure, PM2 mode')
}
run().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
