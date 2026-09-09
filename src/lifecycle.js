'use strict'

/**
 * lifecycle.js — process lifecycle primitives for `wechat-bro up|down`.
 *
 * The system is two long-lived processes that must outlive any agent session:
 *   daemon        `cli.js --daemon`         holds Chrome + WeChat login, serves ws://localhost:<port>
 *   orchestrator  `cli.js orchestrator`     connects to the daemon, dispatches contact tasks
 *
 * `up` is THE idempotent anchor: agent session hooks, launchd/systemd services,
 * agents and humans all run the same command — it probes, starts only what is
 * missing, and waits for the daemon's WebSocket to answer. No accidental
 * auto-spawn ever happens from ordinary commands; only these explicit
 * lifecycle verbs manage processes.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execSync } = require('child_process')
const WebSocket = require('ws')

const DATA_DIR = process.env.WECHAT_BRO_DATA_DIR || path.join(os.homedir(), '.wechat-bro')
const CLI = path.join(__dirname, 'cli.js')

// ── Pidfiles ──────────────────────────────────────────────────────────────
// Written by the processes themselves (daemon mode + runOrchestrator), so
// service-started instances are tracked exactly like `up`-spawned ones.

function pidFile(name) { return path.join(DATA_DIR, `${name}.pid`) }

function writePid(name) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(pidFile(name), String(process.pid))
  } catch {}
}

function clearPid(name) {
  try { fs.unlinkSync(pidFile(name)) } catch {}
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Read a pidfile; return the pid only if alive AND is a wechat-bro cli process (pid reuse guard). */
function readAlivePid(name) {
  let pid
  try { pid = parseInt(fs.readFileSync(pidFile(name), 'utf-8').trim(), 10) } catch { return null }
  if (!pid || !pidAlive(pid)) return null
  if (process.platform === 'win32') return pid // no `ps -o command=` — accept the alive check
  try {
    const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8', timeout: 3000 })
    return /cli\.js/.test(cmd) ? pid : null
  } catch { return null }
}

/** Fall back to scanning the process table (pidfile may be stale/missing). */
function pgrepPid(pattern) {
  if (process.platform === 'win32') return null
  try {
    const out = execSync(`pgrep -f ${JSON.stringify(pattern)} | head -1`, { encoding: 'utf-8', shell: '/bin/sh', timeout: 3000 })
    const pid = parseInt(out.trim(), 10)
    return pid || null
  } catch { return null }
}

// ── Daemon probe ──────────────────────────────────────────────────────────
// The ws-server broadcasts a `connected` event to every new client as soon as
// it listens — independent of page injection/login. So reachability ≠ logged
// in; login state is surfaced by `wechat-bro status` and the `ready` event.

function probeDaemon(port, timeout = 2000) {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok) => { if (!settled) { settled = true; clearTimeout(timer); try { ws.close() } catch {}; resolve(ok) } }
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const timer = setTimeout(() => done(false), timeout)
    ws.on('message', (raw) => {
      try { if (JSON.parse(raw.toString()).event === 'connected') done(true) } catch {}
    })
    ws.on('error', () => done(false))
    ws.on('close', () => done(false))
  })
}

async function waitDaemon(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probeDaemon(port, 1500)) return true
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

// ── Detached spawn ────────────────────────────────────────────────────────
// detached + unref: the child survives this process (and any agent session)
// ending. stdout/stderr go to a log file so crash traces are kept; events
// stay quiet (QUIET auto-on for non-TTY) while WECHAT_BRO_LOG re-enables
// [cli]/[orchestrator] log lines in the file.

function spawnDetached(args, logFile, extraEnv = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const fd = fs.openSync(logFile, 'a')
  const child = spawn(process.execPath, [CLI, ...args], {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, WECHAT_BRO_LOG: '1', ...extraEnv },
  })
  fs.closeSync(fd)
  child.unref()
  return child
}

// ── up ────────────────────────────────────────────────────────────────────

async function ensureUp({ port, harness, timeoutMs = 30_000 } = {}) {
  const result = { port, daemon: {}, orchestrator: {} }

  // 1. Daemon
  if (await probeDaemon(port)) {
    result.daemon = { running: true }
  } else {
    spawnDetached(['--daemon', '--port', String(port)], path.join(DATA_DIR, 'daemon.log'))
    const up = await waitDaemon(port, timeoutMs)
    if (!up) {
      result.ok = false
      result.daemon = { running: false, started: false, error: `daemon did not become reachable on port ${port} within ${timeoutMs / 1000}s — see ${path.join(DATA_DIR, 'daemon.log')} (is another process holding the port?)` }
      return result
    }
    result.daemon = { running: true, started: true, hint: 'first start may need a QR scan — check: wechat-bro status' }
  }

  // 2. Orchestrator (connects with retry, and spawns a daemon child itself
  // if the daemon later dies — so start order never matters)
  let opid = readAlivePid('orchestrator') || pgrepPid('cli.js orchestrator')
  if (opid) {
    result.orchestrator = { running: true, pid: opid }
  } else {
    const args = ['orchestrator', '--port', String(port)]
    if (harness) args.push('--harness', harness)
    const child = spawnDetached(args, path.join(DATA_DIR, 'orchestrator.log'))
    result.orchestrator = { running: true, started: true, pid: child.pid }
  }
  result.ok = true
  return result
}

// ── down ──────────────────────────────────────────────────────────────────
// Orchestrator first (it reconnect-loops while the daemon lives), then the
// daemon via its graceful `exit` path (cookie flush + browser.close()).

async function shutDown({ port } = {}) {
  const result = { ok: true, orchestrator: {}, daemon: {} }

  // 1. Orchestrator
  let opid = readAlivePid('orchestrator') || pgrepPid('cli.js orchestrator')
  if (opid) {
    try { process.kill(opid, 'SIGTERM') } catch {}
    for (let i = 0; i < 30 && pidAlive(opid); i++) await new Promise(r => setTimeout(r, 100))
    if (pidAlive(opid)) { try { process.kill(opid, 'SIGKILL') } catch {} }
    result.orchestrator = { stopped: true, pid: opid }
  } else {
    result.orchestrator = { stopped: false, running: false }
  }
  clearPid('orchestrator')

  // 2. Daemon — prefer the graceful WS exit (flushes cookies), fall back to pidfile.
  if (await probeDaemon(port)) {
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`)
      const done = () => { try { ws.close() } catch {}; resolve() }
      const timer = setTimeout(done, 8000)
      ws.on('open', () => ws.send(JSON.stringify({ cmd: 'exit', id: 'down' })))
      ws.on('message', (raw) => {
        try { if (JSON.parse(raw.toString()).id === 'down') { clearTimeout(timer); done() } } catch {}
      })
      ws.on('error', done)
      ws.on('close', done)
    })
    result.daemon = { stopped: true, graceful: true }
  } else {
    const dpid = readAlivePid('daemon') || pgrepPid('cli.js --daemon')
    if (dpid) {
      try { process.kill(dpid, 'SIGTERM') } catch {}
      result.daemon = { stopped: true, graceful: false, pid: dpid }
    } else {
      result.daemon = { stopped: false, running: false }
    }
  }
  clearPid('daemon')
  return result
}

module.exports = { DATA_DIR, CLI, writePid, clearPid, readAlivePid, probeDaemon, waitDaemon, ensureUp, shutDown }
