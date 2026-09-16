'use strict'

const { spawn } = require('child_process')

function textFrom(value) {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  for (const key of ['text', 'delta', 'content', 'message', 'value']) {
    if (typeof value[key] === 'string') return value[key]
  }
  if (Array.isArray(value.content)) return value.content.map(textFrom).join('')
  return ''
}

class CodexResidentAdapter {
  constructor({ command = 'codex', args = ['app-server', '--stdio'], spawnProcess = spawn, env = process.env, timeoutMs = 900000, requestTimeoutMs = 30000 } = {}) {
    this.command = command
    this.args = args
    this.spawnProcess = spawnProcess
    this.env = env
    this.timeoutMs = timeoutMs
    this.requestTimeoutMs = requestTimeoutMs
    this.child = null
    this.buffer = ''
    this.nextId = 1
    this.pending = new Map()
    this.threads = new Map()
    this.turns = new Map()
    this.bufferedEvents = new Map()
    this.initialized = null
  }

  async start() {
    if (this.initialized) return this.initialized
    this.initialized = new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'], env: this.env })
      this.child = child
      const fail = error => {
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
        this.pending.clear()
        for (const turn of new Set(this.turns.values())) { clearTimeout(turn.timer); turn.resolve({ code: 1, stdout: turn.stdout }) }
        this.turns.clear()
        this.bufferedEvents.clear()
        this.threads.clear()
        this.child = null
        this.initialized = null
        reject(error)
      }
      child.on('error', fail)
      child.on('exit', code => {
        if (this.initialized) fail(new Error(`codex app-server exited with code ${code == null ? 'unknown' : code}`))
      })
      child.stdout.on('data', chunk => this.#read(chunk))
      child.stderr.on('data', () => {})
      this.request('initialize', { clientInfo: { name: 'wechat-bro', version: 'resident' } })
        .then(() => {
          this.#notify('initialized', {})
          resolve(this)
        }, reject)
    })
    return this.initialized
  }

  #read(chunk) {
    this.buffer += chunk.toString()
    let end
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end).trim()
      this.buffer = this.buffer.slice(end + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (!message.method && message.id != null && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error.message || 'codex app-server request failed'))
        else pending.resolve(message.result || {})
        continue
      }
      this.#event(message)
    }
  }

  #event(message) {
    const params = message.params || message.result || {}
    const turnId = params.turnId || params.turn_id || params.turn?.id
    const turn = turnId && this.turns.get(turnId)
    if (!turn) {
      const method = message.method || ''
      if (turnId && (method === 'item/completed' || method === 'turn/completed' || method === 'turn/complete' || method === 'turn/failed' || method === 'turn/error')) {
        const buffered = [...(this.bufferedEvents.get(turnId) || []), message].slice(-16)
        this.bufferedEvents.set(turnId, buffered)
        const timer = setTimeout(() => this.bufferedEvents.delete(turnId), 30000)
        if (typeof timer.unref === 'function') timer.unref()
      }
      return
    }
    const method = message.method || ''
    if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      const text = textFrom(params.item)
      if (text) turn.stdout += (turn.stdout ? '\n' : '') + text
    }
    if (method === 'turn/completed' || method === 'turn/complete' || method === 'turn/failed' || method === 'turn/error') {
      this.turns.delete(turnId)
      if (turn.key) this.turns.delete(`${turn.key}:${turnId}`)
      this.bufferedEvents.delete(turnId)
      clearTimeout(turn.timer)
      const status = params.turn?.status || ''
      const failed = method.includes('failed') || method.includes('error') || status === 'failed' || !!params.turn?.error
      turn.resolve({ code: failed ? 1 : 0, stdout: turn.stdout })
    }
  }

  request(method, params) {
    if (!this.child || !this.child.stdin) return Promise.reject(new Error('codex app-server is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`codex app-server request timed out: ${method}`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  #notify(method, params) {
    if (this.child && this.child.stdin) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  async thread(key, cwd) {
    await this.start()
    if (this.threads.has(key)) return this.threads.get(key)
    const result = await this.request('thread/start', { cwd, sandbox: 'danger-full-access', approvalPolicy: 'never' })
    const id = result.threadId || (result.thread && result.thread.id) || result.id
    if (!id) throw new Error('codex app-server did not return a thread id')
    this.threads.set(key, id)
    return id
  }

  async run(key, { cwd, prompt, timeoutMs = this.timeoutMs } = {}) {
    const threadId = await this.thread(key, cwd)
    const result = await this.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }] })
    const turnId = result.turnId || (result.turn && result.turn.id) || result.id
    if (!turnId) return { code: 0, stdout: textFrom(result) }
    return new Promise(resolve => {
      const turn = { key, threadId, stdout: '', resolve, timer: setTimeout(() => {
        this.cancel(key).catch(() => {})
        resolve({ code: 1, stdout: turn.stdout })
      }, timeoutMs) }
      this.turns.set(turnId, turn)
      this.turns.set(`${key}:${turnId}`, turn)
      const buffered = this.bufferedEvents.get(turnId) || []
      this.bufferedEvents.delete(turnId)
      for (const message of buffered) this.#event(message)
    })
  }

  async cancel(key) {
    const threadId = this.threads.get(key)
    if (threadId) await this.request('turn/interrupt', { threadId }).catch(() => {})
    for (const [id, turn] of this.turns) {
      if (turn.threadId !== threadId) continue
      clearTimeout(turn.timer)
      this.turns.delete(id)
      turn.resolve({ code: 1, stdout: turn.stdout, cancelled: true })
    }
  }

  async close(key) {
    await this.cancel(key)
    this.threads.delete(key)
  }

  async closeAll() {
    for (const key of [...this.threads.keys()]) await this.close(key)
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('codex resident adapter closed')) }
    this.pending.clear()
    this.turns.clear()
    this.bufferedEvents.clear()
    this.threads.clear()
    if (this.child) { try { this.child.kill('SIGTERM') } catch {} }
    this.child = null
    this.initialized = null
  }
}

module.exports = { CodexResidentAdapter }
