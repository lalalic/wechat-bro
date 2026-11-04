'use strict'

/**
 * Minimal CDP page client for the WebHelm-managed Chrome. Replaces puppeteer.
 *
 * wechat-bro owns exactly ONE WebHelm Session (= one tab). It talks to that
 * tab over CDP and never launches, kills, or closes the shared Chrome:
 *
 *   webhelm session start  -> { session_id, target_id }
 *   ws://<chrome>/devtools/page/<target_id>   (realtime events + commands)
 *   webhelm session heartbeat  (every 45s, keeps the 5-minute idle reaper off)
 *   webhelm workspace-delete --force WeChat (on daemon exit)
 *
 * CdpPage duck-types the small puppeteer Page surface wechat-bro uses, so the
 * injected bridge (wechat-bro.js) and its callers stay unchanged.
 */

const { EventEmitter } = require('events')
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const WebSocket = require('ws')

const MIN_WEBHELM_VERSION = '1.0.1'
const HEARTBEAT_MS = 45_000
const SESSION_FILE = 'webhelm-session.json'
const WECHAT_WORKSPACE = 'WeChat'
const COOKIE_FIELDS = ['name', 'value', 'url', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expires', 'priority']

// App-owned Workspaces are provisioned through WebHelm's daemon IPC.
// Never attach a tab without a WebHelm Session lease.
function runtimeSocket() {
  return process.env.WEBHELM_SOCKET || path.join(
    process.env.WEBHELM_RUNTIME_DIR || path.join(os.homedir(), '.config/webhelm/runtime'),
    'session-node.sock'
  )
}

function requestRuntime(payload, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let finished = false
    const socket = net.createConnection(runtimeSocket())
    let data = ''
    const timer = setTimeout(() => finish(new Error('WebHelm IPC timeout')), timeout)
    function finish(error, value) {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket.destroy()
      error ? reject(error) : resolve(value)
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'))
    socket.on('error', (error) => finish(error))
    socket.on('end', () => finish(new Error('WebHelm IPC closed without response')))
    socket.on('data', (chunk) => {
      data += chunk
      const newline = data.indexOf('\n')
      if (newline < 0) return
      try {
        const result = JSON.parse(data.slice(0, newline))
        if (result.error) finish(new Error(String(result.error)))
        else finish(null, result)
      } catch (error) { finish(error) }
    })
  })
}

/**
 * WebHelm is a REQUIRED external runtime/service, not a Node dependency.
 * Validate the IPC protocol and managed Chrome before allocating any tabs.
 * Do not silently attach to an unrelated browser on 127.0.0.1:9222.
 */
function versionAtLeast(actual, required = MIN_WEBHELM_VERSION) {
  const version = String(actual || '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!version) return false
  const current = version.slice(1, 4).map(Number)
  const min = required.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (current[i] !== min[i]) return current[i] > min[i]
  }
  return true
}

function wsBase(endpoint) { return endpoint.replace(/^http/, "ws").replace(/\/+$/, "") }

function dependencyError(message) {
  const error = new Error('webhelm_unavailable: ' + message +
    '. Install/setup WebHelm and verify its daemon: webhelm setup; webhelm status')
  error.code = 'webhelm_unavailable'
  return error
}

async function resolveEndpoint({ request = requestRuntime, env = process.env } = {}) {
  let status
  try {
    status = await request({ op: 'ping' }, 10000)
  } catch (error) {
    throw dependencyError('Session IPC not responding (' + error.message + ')')
  }
  if (!status || !status.ok) throw dependencyError('Session IPC ping returned an invalid response')
  if (!versionAtLeast(status.version)) {
    throw dependencyError('Runtime version ' + String(status.version || 'unknown') +
      ' is older than required ' + MIN_WEBHELM_VERSION)
  }
  const endpoint = status.managed_chrome && status.managed_chrome.endpoint
  if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint)) {
    throw dependencyError('Runtime did not report a managed Chrome CDP endpoint')
  }
  if (env.WEBHELM_CDP_ENDPOINT &&
      env.WEBHELM_CDP_ENDPOINT.replace(/\/+$/, '') !== endpoint.replace(/\/+$/, '')) {
    throw dependencyError('WEBHELM_CDP_ENDPOINT differs from the WebHelm-owned Chrome endpoint')
  }
  let guard = status.chrome_guard
  if (!guard || guard.status !== 'healthy') {
    try {
      const recovered = await request({ op: 'guard-check' }, 15000)
      guard = recovered && recovered.chrome_guard
    } catch (error) {
      throw dependencyError('managed Chrome health check failed (' + error.message + ')')
    }
  }
  if (!guard || (guard.status !== 'healthy' && !guard.skipped)) {
    throw dependencyError('managed Chrome is ' + String(guard && guard.status || 'unavailable'))
  }
  return { endpoint, version: status.version, profile: status.managed_chrome.profile_dir }
}

/**
 * A daemon exclusively owns the named WeChat workspace. Never touch another
 * group's leases. Deletion closes the WeChat tabs directly, avoiding the
 * Page.navigate-to-idle hang seen in real logged-in WeChat sessions.
 *
 * Workspace deletion closes the Chrome tabs first; then we stop any remaining
 * Session records after their CDP targets disappear. This works with existing
 * WebHelm Runtime versions, without modifying or restarting the daemon.
 */
async function destroyWechatWorkspace({ sessionId = null, dataDir = null } = {}) {
  const state = await requestRuntime({ op: 'list' })
  const owned = (state.sessions || []).filter(s => s.workspace === WECHAT_WORKSPACE)
  if (owned.some(s => !sessionId || s.session_id !== sessionId)) {
    throw new Error('WeChat workspace contains a Session owned by a different daemon')
  }
  const result = await requestRuntime({
    op: 'workspace-delete', name: WECHAT_WORKSPACE, force: true,
  }, 45000)
  if (!result.deleted) throw new Error('WebHelm did not confirm WeChat Group deletion')
  // Existing WebHelm releases keep the Session record after deleting its
  // group, but Target.targetDestroyed removes the now-closed target. Calling
  // Session stop *after* that event releases the in-memory lease without the
  // problematic Page.navigate-to-idle. Future runtimes may revoke the record
  // during group deletion; either behavior is supported.
  for (const session of owned) {
    let current = null
    for (let attempt = 0; attempt < 60; attempt++) {
      const listing = await requestRuntime({ op: 'list' })
      current = (listing.sessions || []).find(s => s.session_id === session.session_id)
      if (!current || !current.target_id) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (current && current.target_id) {
      throw new Error('WeChat Group was deleted but Chrome target did not close; Session not safe to recycle')
    }
    if (current) {
      try { await requestRuntime({ op: 'stop', session_id: session.session_id }, 20000) }
      catch (error) {
        if (!/unknown session_id/i.test(String(error.message))) throw error
      }
    }
  }
  const after = await requestRuntime({ op: 'list' })
  if ((after.sessions || []).some(s => s.workspace === WECHAT_WORKSPACE)) {
    throw new Error('WebHelm deleted WeChat Group but failed to revoke its Session leases')
  }
  if (dataDir) {
    try { fs.unlinkSync(path.join(dataDir, SESSION_FILE)) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return result
}

/** Reclaim only our own recorded Session from a previously crashed daemon. */
async function reapStaleSession(dataDir) {
  if (!dataDir) return
  const file = path.join(dataDir, SESSION_FILE)
  if (!fs.existsSync(file)) return
  let stored
  try { stored = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return }
  if (stored.pid && stored.pid !== process.pid) {
    try { process.kill(stored.pid, 0); throw new Error('WeChat WebHelm Session is owned by another live process: ' + stored.pid) }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  if (!stored.sessionId) throw new Error('stale WeChat Session receipt has no sessionId')
  await destroyWechatWorkspace({ sessionId: stored.sessionId, dataDir })
}

// ── CDP connection ────────────────────────────────────────────────────────
class CdpConnection extends EventEmitter {
  constructor(ws) {
    super()
    this.ws = ws
    this.nextId = 0
    this.pending = new Map()
    this.closed = false
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch { return }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`))
        else p.resolve(msg.result || {})
      } else if (msg.method) {
        this.emit('event', msg.method, msg.params || {})
      }
    })
    ws.on('close', () => this._onClose())
    ws.on('error', () => {})  // a 'close' always follows
  }

  static connect(url, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
      const timer = setTimeout(() => { try { ws.terminate() } catch {}; reject(new Error(`CDP connect timeout: ${url}`)) }, timeoutMs)
      ws.once('open', () => { clearTimeout(timer); resolve(new CdpConnection(ws)) })
      ws.once('error', (e) => { clearTimeout(timer); reject(e) })
    })
  }

  send(method, params = {}, timeoutMs = 60_000) {
    if (this.closed) return Promise.reject(new Error(`${method}: CDP connection closed`))
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method}: CDP timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { method, resolve, reject, timer })
      try { this.ws.send(JSON.stringify({ id, method, params })) } catch (e) {
        this.pending.delete(id); clearTimeout(timer); reject(e)
      }
    })
  }

  _onClose() {
    if (this.closed) return
    this.closed = true
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`${p.method}: CDP connection closed`)) }
    this.pending.clear()
    this.emit('close')
  }

  close() {
    try { this.ws.close() } catch {}
    const t = setTimeout(() => { try { this.ws.terminate() } catch {} }, 1000)
    if (t.unref) t.unref()
  }
}

function describeException(d) {
  const ex = d.exception || {}
  return `Evaluation failed: ${ex.description || ex.value || d.text || 'unknown error'}`
}

/** Serialize call arguments; `undefined` must stay `undefined` (JSON turns it into null). */
function serializeArgs(args) {
  return args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(',')
}

// ── Page ──────────────────────────────────────────────────────────────────
class CdpPage extends EventEmitter {
  constructor(conn) {
    super()
    this.conn = conn
    this.closed = false
    this._url = 'about:blank'
    this._bindings = new Map()
    this._mainFrame = { url: () => this._url }
    conn.on('event', (method, params) => this._onEvent(method, params))
    conn.on('close', () => {
      if (this.closed) return
      this.closed = true
      this.emit('close')
    })
  }

  send(method, params, timeoutMs) { return this.conn.send(method, params, timeoutMs) }
  url() { return this._url }
  mainFrame() { return this._mainFrame }

  async init({ width = 1280, height = 900 } = {}) {
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true }).catch(() => {})
    // Our tab usually sits in the background of a shared, headed Chrome:
    // pretend it is focused so timers/rendering are not throttled.
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }).catch(() => {})
    const tree = await this.send('Page.getFrameTree')
    this._url = tree.frameTree.frame.url
  }

  _onEvent(method, params) {
    switch (method) {
      case 'Runtime.bindingCalled': this._onBinding(params); break
      case 'Page.frameNavigated':
        if (!params.frame.parentId) {
          this._url = params.frame.url + (params.frame.urlFragment || '')
          this.emit('framenavigated', this._mainFrame)
        }
        break
      case 'Page.navigatedWithinDocument':
        this._url = params.url
        this.emit('framenavigated', this._mainFrame)
        break
      case 'Page.javascriptDialogOpening': {
        const dialog = {
          message: () => params.message,
          type: () => params.type,
          accept: (promptText) => this.send('Page.handleJavaScriptDialog', { accept: true, promptText }),
          dismiss: () => this.send('Page.handleJavaScriptDialog', { accept: false }),
        }
        if (this.listenerCount('dialog')) this.emit('dialog', dialog)
        else dialog.dismiss().catch(() => {})
        break
      }
      case 'Inspector.targetCrashed':
        if (this.listenerCount('error')) this.emit('error', new Error('Page crashed'))
        break
      case 'Runtime.consoleAPICalled':
        if (this.listenerCount('console')) {
          const text = (params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || ''))).join(' ')
          this.emit('console', { text: () => text, type: () => params.type })
        }
        break
      case 'Runtime.exceptionThrown':
        if (this.listenerCount('pageerror')) this.emit('pageerror', new Error(describeException(params.exceptionDetails)))
        break
    }
    this.emit('cdp', method, params)
  }

  _onBinding({ name, payload }) {
    const fn = this._bindings.get(name)
    if (!fn) return
    let args
    try { args = JSON.parse(payload) } catch { return }
    Promise.resolve().then(() => fn(...args)).catch((e) => console.error('[cdp] bridge handler failed:', e && e.message))
  }

  /** puppeteer-compatible: fn(...args) or a string expression; awaits promises. */
  async evaluate(fn, ...args) {
    const expression = typeof fn === 'function' ? `(${fn.toString()})(${serializeArgs(args)})` : String(fn)
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(describeException(r.exceptionDetails))
    return r.result ? r.result.value : undefined
  }

  /** Poll fn until truthy (puppeteer: waitForFunction(fn, options, ...args)). */
  async waitForFunction(fn, options = {}, ...args) {
    const timeout = options.timeout === undefined ? 30_000 : options.timeout
    const interval = options.pollingInterval || 100
    const deadline = Date.now() + timeout
    for (;;) {
      if (this.closed) throw new Error('Waiting failed: page closed')
      try {
        const v = await this.evaluate(fn, ...args)
        if (v) return v
      } catch (e) {
        if (this.closed) throw e  // transient errors while navigating are retried
      }
      if (timeout && Date.now() >= deadline) {
        const err = new Error(`Waiting failed: ${timeout}ms exceeded`)
        err.name = 'TimeoutError'
        throw err
      }
      await new Promise((r) => setTimeout(r, interval))
    }
  }

  _waiter(predicate, timeoutMs) {
    let cancel
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Navigation timeout of ${timeoutMs} ms exceeded`)) }, timeoutMs)
      const onEvent = (method, params) => { if (predicate(method, params)) { cleanup(); resolve() } }
      const onClose = () => { cleanup(); reject(new Error('Navigation failed because page was closed')) }
      const cleanup = () => { clearTimeout(timer); this.off('cdp', onEvent); this.off('close', onClose) }
      this.on('cdp', onEvent)
      this.on('close', onClose)
      cancel = cleanup
    })
    promise.catch(() => {})
    return { promise, cancel }
  }

  async goto(url, { waitUntil = 'load', timeout = 30_000 } = {}) {
    const wanted = Array.isArray(waitUntil) ? waitUntil[0] : waitUntil
    const predicate = wanted === 'domcontentloaded' ? (m) => m === 'Page.domContentEventFired'
      : wanted === 'load' ? (m) => m === 'Page.loadEventFired'
      : (m, p) => m === 'Page.lifecycleEvent' && p.name === (wanted === 'networkidle0' ? 'networkIdle' : 'networkAlmostIdle')
    const waiter = this._waiter(predicate, timeout)
    let nav
    try { nav = await this.send('Page.navigate', { url }) } catch (e) { waiter.cancel(); throw e }
    if (nav.errorText) { waiter.cancel(); throw new Error(`${nav.errorText} at ${url}`) }
    if (!nav.loaderId) { waiter.cancel(); return }  // same-document navigation
    await waiter.promise
  }

  /** Cookies applicable to the current page URL (or the given urls). */
  async cookies(...urls) {
    const r = await this.send('Network.getCookies', { urls: urls.length ? urls : [this._url] })
    return r.cookies
  }

  async setCookie(...cookies) {
    const items = cookies.map((c) => {
      const o = {}
      for (const k of COOKIE_FIELDS) if (c[k] !== undefined) o[k] = c[k]
      if (c.session || !(o.expires > 0)) delete o.expires
      if (!o.url && !o.domain) o.url = this._url
      return o
    })
    if (items.length) await this.send('Network.setCookies', { cookies: items })
  }

  async deleteCookie(...cookies) {
    for (const c of cookies) {
      await this.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path, url: c.url })
    }
  }

  /** puppeteer-compatible: window[name](...args) calls fn(...args) in Node. */
  async exposeFunction(name, fn) {
    const binding = `__wb_${name}`
    this._bindings.set(binding, fn)
    await this.send('Runtime.addBinding', { name: binding })
    const shim = `window.${name} = (...a) => { try { window.${binding}(JSON.stringify(a)) } catch (e) {} return Promise.resolve() }`
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: shim })
    await this.evaluate(shim)
  }

  /** Minimal ElementHandle: enough for <input type=file> uploads. */
  async $(selector) {
    const { root } = await this.send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    if (!nodeId) return null
    return {
      uploadFile: async (...files) => {
        await this.send('DOM.setFileInputFiles', { nodeId, files: files.map((f) => path.resolve(f)) })
      },
    }
  }

  bringToFront() { return this.send('Page.bringToFront') }
  close() { this.conn.close() }
}

// ── Browser (one WebHelm Session) ─────────────────────────────────────────
class WebHelmBrowser extends EventEmitter {
  constructor({ sessionId, targetId, page, dataDir }) {
    super()
    this.sessionId = sessionId
    this.targetId = targetId
    this.page = page
    this.dataDir = dataDir
    this.closed = false
    this._heartbeatFailures = 0
    this._heartbeatInFlight = false
    this._leaseLost = false
    this._hb = setInterval(() => { this.heartbeat().catch(e => this.emit('heartbeat-error', e)) }, HEARTBEAT_MS)
    if (this._hb.unref) this._hb.unref()
    page.on('close', () => { if (!this.closed) this.emit('disconnected') })
  }

  async heartbeat() {
    if (this.closed || this._heartbeatInFlight || this._leaseLost) return
    this._heartbeatInFlight = true
    try {
      const receipt = await requestRuntime({ op: 'heartbeat', session_id: this.sessionId }, 15_000)
      if (!receipt.alive || receipt.session_id !== this.sessionId) throw Error('invalid WebHelm heartbeat receipt')
      this._heartbeatFailures = 0
    } catch (error) {
      this._heartbeatFailures++
      this.emit('heartbeat-error', error)
      // A lost WebHelm Session must be recovered, not silently kept alive
      // through a still-connected raw CDP socket.
      if (/unknown session_id/i.test(String(error.message)) || this._heartbeatFailures >= 3) {
        this._leaseLost = true
        this.emit('disconnected')
      }
    } finally { this._heartbeatInFlight = false }
  }

  /** Open one tab through WebHelm. Never launches or kills Chrome. */
  static async open({ url = 'about:blank', headed = false, dataDir, viewport } = {}) {
    const { endpoint } = await resolveEndpoint()
    await reapStaleSession(dataDir)
    await requestRuntime({ op: 'workspace-create', name: WECHAT_WORKSPACE, pool_size: 1 })
    const started = await requestRuntime({ op: 'start', workspace: WECHAT_WORKSPACE, url })
    if (!started.session_id || !started.target_id) throw new Error('webhelm session start returned no session_id/target_id')
    let conn
    try {
      conn = await CdpConnection.connect(`${wsBase(endpoint)}/devtools/page/${started.target_id}`)
      const page = new CdpPage(conn)
      await page.init(viewport)
      if (headed) await page.bringToFront().catch(() => {})
      const browser = new WebHelmBrowser({ sessionId: started.session_id, targetId: started.target_id, page, dataDir })
      if (dataDir) {
        try { fs.writeFileSync(path.join(dataDir, SESSION_FILE), JSON.stringify({ sessionId: started.session_id, targetId: started.target_id, pid: process.pid, ts: Date.now() })) } catch {}
      }
      return browser
    } catch (e) {
      try { if (conn) conn.close() } catch {}
      try { await destroyWechatWorkspace({ sessionId: started.session_id, dataDir }) }
      catch (cleanupError) { e.cleanupError = cleanupError }
      throw e
    }
  }

  async pages() { return [this.page] }

  /** Destroys this daemon's WeChat Tab Group and revokes its Session. */
  async close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this._hb)
    try {
      return await destroyWechatWorkspace({ sessionId: this.sessionId, dataDir: this.dataDir })
    } finally {
      try { this.page.close() } catch {}
    }
  }

}

/** System Chrome for external renderers (mermaid / marp). No download. */
function findSystemChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const candidates = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
  }[process.platform] || []
  return candidates.find((p) => fs.existsSync(p)) || null
}

module.exports = { WebHelmBrowser, CdpPage, CdpConnection, findSystemChrome, serializeArgs, requestRuntime, destroyWechatWorkspace, resolveEndpoint, versionAtLeast, MIN_WEBHELM_VERSION, wsBase }
