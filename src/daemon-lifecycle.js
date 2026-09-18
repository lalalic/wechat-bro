'use strict'

const { spawn } = require('child_process')

const STATES = Object.freeze({
  AUTHENTICATED: 'authenticated',
  HEALTHY: 'authenticated',
  SUSPENDED: 'suspended',
  RESUMING: 'resuming/revalidating',
  RECOVERING: 'page_lost/recovering',
  LOGIN_REQUIRED: 'login_required',
})

const AUTH_COMMANDS = new Set([
  'contacts', 'rooms', 'room-members', 'get-contact',
  'send-text', 'send', 'send-image', 'send-video', 'send-file', 'send-voice',
  'emojis', 'supported-emojis', 'config',
])

function loginRequiredError(reason) {
  const error = new Error('login_required' + (reason ? ': ' + reason : ''))
  error.code = 'login_required'
  return error
}

function classifyPageSignals(signals) {
  if (!signals || signals.pageLost || signals.pageReady === false) return STATES.RECOVERING
  if (signals.authenticated === true) return STATES.AUTHENTICATED

  const loggedIn = signals.isLogin === true || signals.mmCgiLogin === true
  const hasAccount = !!(signals.userName || signals.account)
  if (loggedIn && (hasAccount || signals.chatUi || signals.bridgeLogin)) return STATES.AUTHENTICATED
  // MMCgi.isLogin can be unavailable/stale after startup reinjection. The
  // current page's bridge state plus a completed contact load is an explicit
  // authenticated signal; do not leave a healthy daemon in recovery.
  if (signals.bridgeLogin === true && signals.contactsReady === true) return STATES.AUTHENTICATED

  const loginUi = !!signals.loginUi
  const chatUi = !!signals.chatUi
  if (signals.loginRequired || (signals.isLogin === false && loginUi && !chatUi)) {
    return STATES.LOGIN_REQUIRED
  }
  if (signals.url && !loginUi && !chatUi && signals.isLogin === false) return STATES.RECOVERING
  return STATES.RECOVERING
}

async function readPageSignals(page) {
  return page.evaluate(() => {
    let userName = ''
    try {
      const injector = angular.element(document).injector()
      const account = injector && injector.get('accountFactory')
      userName = account && account.getUserName ? (account.getUserName() || '') : ''
    } catch {}

    const bridge = window.WechatyBro
    const loginUi = !!document.querySelector('.login_box, .qrcode, [ng-controller="loginController"]')
    const chatUi = !!document.querySelector('.chat_box, #chatArea, .box_ft, [ng-controller="chatController"]')
    return {
      url: location.href,
      pageReady: !!(window.angular && angular.element && angular.element(document).injector()),
      isLogin: !!(window.MMCgi && window.MMCgi.isLogin),
      userName,
      bridgeLogin: !!(bridge && bridge.vars && bridge.vars.loginState),
      contactsReady: !!(bridge && bridge.vars && bridge.vars.contactsReady),
      loginUi,
      chatUi,
    }
  })
}

// JXA is built into macOS. Unlike `pmset -g log`, this receives notifications
// live and therefore can flush before the machine actually suspends.
const MAC_SLEEP_SCRIPT = [
  'ObjC.import("Cocoa");',
  'ObjC.registerSubclass({name:"WechatBroSleepWatcher",methods:{"receiveNotification:":{types:["void",["id"]],implementation:function(n){console.log(ObjC.unwrap(n.name)+"\\t"+new Date().toISOString());}}}});',
  'var w=$.WechatBroSleepWatcher.alloc.init;',
  'var c=$.NSWorkspace.sharedWorkspace.notificationCenter;',
  'c.addObserverSelectorNameObject(w,"receiveNotification:",$.NSWorkspaceWillSleepNotification,null);',
  'c.addObserverSelectorNameObject(w,"receiveNotification:",$.NSWorkspaceDidWakeNotification,null);',
  '$.NSRunLoop.currentRunLoop.run();',
].join('')

/**
 * Optional live macOS sleep observer. If the native runtime is unavailable or
 * exits, timer-gap detection remains authoritative; no historical sleep log
 * rows are interpreted as a pre-sleep signal.
 */
function createMacSleepObserver({
  platform = process.platform,
  onSleep = () => {},
  onWake = () => {},
  log = () => {},
  spawnProcess = spawn,
} = {}) {
  let child = null
  let startedAt = 0
  let pending = ''
  const seen = new Set()

  function handleLine(line) {
    const value = String(line || '').trim()
    if (!value || seen.has(value)) return
    seen.add(value)
    if (seen.size > 50) seen.delete(seen.values().next().value)
    const parts = value.split('\t')
    const name = parts[0]
    const eventAt = parts[1] ? Date.parse(parts[1]) : NaN
    if (Number.isFinite(eventAt) && eventAt < startedAt) return
    try {
      if (name === 'NSWorkspaceWillSleepNotification') onSleep({ source: 'NSWorkspace', name })
      else if (name === 'NSWorkspaceDidWakeNotification') onWake({ source: 'NSWorkspace', name })
    } catch (e) { log('sleep observer:', e.message) }
  }

  function handleChunk(chunk) {
    pending += String(chunk)
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() || ''
    lines.forEach(handleLine)
  }

  return {
    start() {
      if (platform !== 'darwin' || child) return
      try {
        startedAt = Date.now()
        child = spawnProcess('osascript', ['-l', 'JavaScript', '-e', MAC_SLEEP_SCRIPT], {
          // JXA console.log writes to stderr on macOS.
          stdio: ['ignore', 'ignore', 'pipe'],
        })
        child.stderr.on('data', handleChunk)
        child.once('error', error => {
          log('sleep observer unavailable:', error.message)
          child = null
        })
        child.once('exit', () => { child = null })
      } catch (e) {
        log('sleep observer unavailable:', e.message)
        child = null
      }
    },
    stop() {
      if (child) {
        try { child.kill('SIGTERM') } catch {}
      }
      child = null
    },
  }
}

class DaemonLifecycle {
  constructor(options = {}) {
    this.state = STATES.RECOVERING
    this.previousAuthenticated = false
    this.page = null
    this.lastTickAt = options.now ? options.now() : Date.now()
    this.now = options.now || (() => Date.now())
    this.tickMs = options.tickMs || 60000
    this.gapMs = options.gapMs || 180000
    this.maxAttempts = options.maxAttempts === undefined ? 3 : options.maxAttempts
    this.retryDelaysMs = options.retryDelaysMs || [1000, 5000]
    this.log = options.log || (() => {})
    this.emit = options.emit || (() => {})
    this.flush = options.flush || (async () => {})
    this.recoverPage = options.recoverPage || null
    this.probe = options.probe || ((page) => readPageSignals(page))
    this.sleep = options.sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)))
    this.setInterval = options.setInterval || setInterval
    this.clearInterval = options.clearInterval || clearInterval
    this.observer = options.observer || createMacSleepObserver({
      log: this.log,
      onSleep: (detail) => this.handleSleep('macOS sleep', detail),
      onWake: (detail) => this.handleWake('macOS wake', detail),
    })
    this.timer = null
    this.revalidation = null
    this.recovery = null
    this.lastSignals = null
    this.transitionLog = []
  }

  transition(next, reason, detail) {
    const previous = this.state
    if (previous === next) return false
    this.state = next
    const at = new Date(this.now()).toISOString()
    const row = { previous, state: next, reason: reason || 'unspecified', at, detail: detail || null }
    this.transitionLog.push(row)
    if (this.transitionLog.length > 50) this.transitionLog.shift()
    this.log(`lifecycle ${previous} -> ${next} (${row.reason}) @ ${at}`)
    this.emit({ event: 'lifecycle', data: { ...row } })
    return true
  }

  setPage(page) { this.page = page; return this }

  pageReplaced(page, reason = 'page replaced') {
    this.page = page || null
    this.transition(STATES.RECOVERING, reason)
    return this.revalidation
  }

  pageLost(reason = 'page lost', detail) {
    this.page = null
    this.transition(STATES.RECOVERING, reason, detail)
    return this.recover(reason)
  }

  async recover(reason = 'page lost') {
    if (!this.recoverPage) return STATES.RECOVERING
    if (this.recovery) return this.recovery
    this.recovery = (async () => {
      let lastError = null
      for (let attempt = 0; attempt <= this.maxAttempts; attempt++) {
        try {
          const page = await this.recoverPage(reason, attempt)
          if (!page) throw new Error('page recovery unavailable')
          this.setPage(page)
          const result = await this.revalidate(`page recovery: ${reason}`)
          if (result !== STATES.RECOVERING) return result
          lastError = new Error('page_lost/recovering')
        } catch (e) {
          lastError = e
        }
        if (attempt >= this.maxAttempts) break
        const delay = this.retryDelaysMs[attempt] === undefined
          ? this.retryDelaysMs[this.retryDelaysMs.length - 1] || 0
          : this.retryDelaysMs[attempt]
        if (delay > 0) await this.sleep(delay)
      }
      this.transition(STATES.RECOVERING, reason, { error: lastError && lastError.message })
      return STATES.RECOVERING
    })()
    try { return await this.recovery } finally { this.recovery = null }
  }

  handleBridgeEvent(event) {
    if (event !== 'login' && event !== 'logout' && event !== 'scan') return
    if (event === 'logout' || event === 'scan') this.transition(STATES.RESUMING, `bridge ${event}`)
    this.revalidate(`bridge ${event}`).catch(e => this.log('lifecycle revalidation:', e.message))
  }

  async handleSleep(reason = 'sleep', detail) {
    this.lastTickAt = this.now()
    this.transition(STATES.SUSPENDED, reason, detail)
    try { await this.flush() } catch (e) { this.log('lifecycle sleep flush:', e.message) }
  }

  handleWake(reason = 'wake', detail) {
    this.lastTickAt = this.now()
    this.transition(STATES.RESUMING, reason, detail)
    return this.revalidate(reason)
  }

  async tick(at = this.now()) {
    const elapsed = at - this.lastTickAt
    this.lastTickAt = at
    if (elapsed > this.gapMs) {
      await this.handleSleep('timer gap', { elapsedMs: elapsed })
      return this.handleWake('timer gap wake', { elapsedMs: elapsed })
    }
    return null
  }

  start() {
    if (this.timer) return this
    this.lastTickAt = this.now()
    this.timer = this.setInterval(() => {
      this.tick().catch(e => this.log('lifecycle tick:', e.message))
    }, this.tickMs)
    if (this.timer.unref) this.timer.unref()
    if (this.observer && this.observer.start) this.observer.start()
    return this
  }

  stop() {
    if (this.timer) this.clearInterval(this.timer)
    this.timer = null
    if (this.observer && this.observer.stop) this.observer.stop()
  }

  async revalidate(reason = 'revalidate') {
    if (this.revalidation) return this.revalidation
    this.revalidation = (async () => {
      this.transition(STATES.RESUMING, reason)
      let lastError = null
      for (let attempt = 0; attempt <= this.maxAttempts; attempt++) {
        try {
          if (!this.page) throw new Error('page unavailable')
          const signals = await this.probe(this.page)
          this.lastSignals = signals
          const result = classifyPageSignals(signals)
          if (result === STATES.AUTHENTICATED) {
            this.previousAuthenticated = true
            this.transition(STATES.AUTHENTICATED, reason, { attempt, signals })
            return result
          }
          if (result === STATES.LOGIN_REQUIRED) {
            this.transition(STATES.LOGIN_REQUIRED, reason, { attempt, signals })
            return result
          }
          lastError = new Error('page_lost/recovering')
        } catch (e) {
          lastError = e
        }
        if (attempt >= this.maxAttempts) break
        const delay = this.retryDelaysMs[attempt] === undefined
          ? this.retryDelaysMs[this.retryDelaysMs.length - 1] || 0
          : this.retryDelaysMs[attempt]
        if (delay > 0) await this.sleep(delay)
      }
      this.transition(STATES.RECOVERING, reason, { error: lastError && lastError.message })
      return STATES.RECOVERING
    })()
    try { return await this.revalidation } finally { this.revalidation = null }
  }

  isAuthenticated() { return this.state === STATES.AUTHENTICATED }

  readyData(contactsReady) {
    return { loggedIn: this.isAuthenticated(), contactsReady: !!contactsReady, lifecycle: this.state }
  }

  requireAuthenticated() {
    if (this.state === STATES.LOGIN_REQUIRED) throw loginRequiredError('WeChat confirmation or QR scan is required')
    if (!this.isAuthenticated()) throw new Error('session_unavailable: ' + this.state)
  }
}

function isAuthCommand(cmd) { return AUTH_COMMANDS.has(cmd) }

module.exports = {
  AUTH_COMMANDS,
  DaemonLifecycle,
  STATES,
  classifyPageSignals,
  createMacSleepObserver,
  isAuthCommand,
  loginRequiredError,
  readPageSignals,
}
