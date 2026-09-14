'use strict'

const assert = require('assert')
const { EventEmitter } = require('events')
const {
  DaemonLifecycle,
  STATES,
  classifyPageSignals,
  createMacSleepObserver,
  isAuthCommand,
} = require('../src/daemon-lifecycle')

async function run() {
  console.log('# daemon lifecycle')

  assert.strictEqual(classifyPageSignals({ isLogin: true, userName: '@me', chatUi: true }), STATES.AUTHENTICATED)
  assert.strictEqual(classifyPageSignals({ isLogin: false, loginUi: true, chatUi: false }), STATES.LOGIN_REQUIRED)
  assert.strictEqual(classifyPageSignals({ pageLost: true }), STATES.RECOVERING)
  console.log('  ok - page signals distinguish authenticated, login_required, and page_lost')

  let now = 0
  let probes = 0
  let flushes = 0
  let observed = []
  const lifecycle = new DaemonLifecycle({
    now: () => now,
    gapMs: 120,
    maxAttempts: 0,
    probe: async () => { probes++; return { authenticated: true } },
    flush: async () => { flushes++ },
    emit: event => observed.push(event),
    observer: { start() {}, stop() {} },
  }).setPage({})

  now = 60
  await lifecycle.tick()
  assert.strictEqual(probes, 0, 'normal timer cadence does not revalidate')
  now = 500
  await lifecycle.tick()
  assert.strictEqual(probes, 1, 'abnormal timer gap revalidates')
  assert.strictEqual(flushes, 1, 'gap path performs best-effort suspend flush')
  assert.strictEqual(lifecycle.state, STATES.AUTHENTICATED)
  assert(observed.some(e => e.data.state === STATES.SUSPENDED))
  assert(observed.some(e => e.data.state === STATES.RESUMING))
  console.log('  ok - normal cadence vs timer gap and gap/wake revalidation')

  let current = { authenticated: true }
  const replacement = new DaemonLifecycle({
    maxAttempts: 0,
    probe: async () => current,
    observer: { start() {}, stop() {} },
  }).setPage({ generation: 1 })
  await replacement.revalidate('initial login')
  assert.strictEqual(replacement.previousAuthenticated, true)
  replacement.pageReplaced({ generation: 2 }, 'navigation/reinjection')
  assert.strictEqual(replacement.previousAuthenticated, true, 'daemon auth knowledge survives page replacement')
  current = { isLogin: false, loginUi: true, chatUi: false }
  await replacement.revalidate('replaced page')
  assert.strictEqual(replacement.state, STATES.LOGIN_REQUIRED)
  assert.strictEqual(replacement.readyData(true).loggedIn, false, 'ready state is current, not the pre-login snapshot')
  assert.throws(() => replacement.requireAuthenticated(), /login_required/)
  console.log('  ok - navigation/reinjection preserves prior auth and surfaces login_required')

  let attempts = 0
  const delays = []
  const recovering = new DaemonLifecycle({
    maxAttempts: 2,
    retryDelaysMs: [1, 1],
    sleep: async ms => delays.push(ms),
    probe: async () => { attempts++; throw new Error('renderer unavailable') },
    observer: { start() {}, stop() {} },
  }).setPage({})
  await recovering.revalidate('bounded recovery')
  assert.strictEqual(attempts, 3, 'recovery attempts are bounded')
  assert.strictEqual(recovering.state, STATES.RECOVERING)
  assert.strictEqual(delays.length, 2, 'backoff is only used between bounded attempts')
  console.log('  ok - bounded recovery/backoff')

  assert.strictEqual(isAuthCommand('send-text'), true)
  assert.strictEqual(isAuthCommand('status'), false)
  const child = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = () => { child.killed = true }
  const spawned = []
  const sleepEvents = []
  const wakeEvents = []
  const observer = createMacSleepObserver({
    platform: 'darwin',
    spawnProcess: (...args) => { spawned.push(args); return child },
    onSleep: event => sleepEvents.push(event),
    onWake: event => wakeEvents.push(event),
  })
  observer.start()
  assert.strictEqual(spawned.length, 1)
  assert(spawned[0][1][0] === '-l' && spawned[0][1][1] === 'JavaScript')
  assert.deepStrictEqual(spawned[0][2].stdio, ['ignore', 'ignore', 'pipe'])
  child.stderr.emit('data', Buffer.from('NSWorkspaceWillSleepNotification\t2099-01-01T00:'))
  child.stderr.emit('data', Buffer.from('00:00.000Z\n'))
  child.stderr.emit('data', Buffer.from('NSWorkspaceWillSleepNotification\t2099-01-01T00:00:00.000Z\n'))
  child.stderr.emit('data', Buffer.from('NSWorkspaceDidWakeNotification\t2099-01-01T00:00:01.000Z\n'))
  child.stderr.emit('data', Buffer.from('NSWorkspaceDidWakeNotification\t2000-01-01T00:00:01.000Z\n'))
  assert.strictEqual(sleepEvents.length, 1, 'duplicate native sleep event is ignored')
  assert.strictEqual(wakeEvents.length, 1, 'old native wake event is ignored')
  observer.stop()
  assert.strictEqual(child.killed, true)
  console.log('  ok - live native observer handles pre-sleep/wake once and ignores duplicate/old events')
  let fallbackSpawned = 0
  createMacSleepObserver({ platform: 'linux', spawnProcess: () => { fallbackSpawned++ } }).start()
  assert.strictEqual(fallbackSpawned, 0, 'non-macOS observer is optional')
  lifecycle.stop(); replacement.stop(); recovering.stop()
  console.log('  ok - auth command classification')
  console.log('\n--- Results ---\n  Passed: 8\n  Failed: 0')
}

run().catch(error => {
  console.error('FATAL', error)
  process.exit(1)
})
