#!/usr/bin/env node

/**
 * cli.js — WebSocket + stdin JSON-line interface for AI agents.
 *
 * Uses a long-lived WebHelm Chrome tab for wx.qq.com; never starts Chrome.
 * Supports multiple agents via WebSocket (ws://localhost:9231).
 * Also reads JSON commands from stdin for backward compatibility.
 *
 * Usage:
 *   node cli.js                    # Headless, WebSocket on :9231
 *   node cli.js --headed           # Show browser
 *   node cli.js --port 9231       # Custom WebSocket port
 *
 * WebSocket Protocol:
 *   Agent → Server:  {"cmd":"auth","agent":"testneo"}   # optional, identify
 *   Agent → Server:  {"cmd":"contacts","id":"req-1"}    # any command
 *   Server → Agent:  {"ok":true,"id":"req-1","data":[]} # response
 *   Server → Agent:  {"event":"message","data":{},"ts":...} # broadcast event
 *
 * Commands:
 *   contacts          → [name]                       (individuals only)
 *   rooms             → [name]                       (group chats only)
 *   room-members      → [name]                       (args: --name <room>)
 *   get-contact       → {name, isRoomContact, ...}   (args: --name <contact|room>)
 *   send-text         → {sent: true, to}              (args: --to, --content)
 *   send-image        → {sent: true, to, file}        (args: --to, --path, [--filename])
 *   send-video        → {sent: true, to, file}        (args: --to, --path, [--filename])
 *   send-file         → {sent: true, to, file}        (args: --to, --path, --filename)
 *   send-voice        → {sent, to, transcription}     (args: --to, --path)
 *   status            → orchestrator watch/runtime state + daemon health
 *   emojis            → [string]
 *   ping              → {pong: true, ts: ...}         (liveness check)
 *   exit              → shut down
 */

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const readline = require('readline')
const { WebHelmBrowser, findSystemChrome, resolveEndpoint } = require('./cdp')
const qrcode = require('qrcode-terminal')
// NOTE: WeChat login QR code is intentionally NOT drawn in the terminal.
// The scan event emits {url} — open it in a browser window (headless mode)
// or paste the URL into any browser to scan. This keeps terminal output
// clean JSON lines for agents.
const WebSocket = require('ws')
const { transcribeVoiceAsync, transcribeFileAsync } = require('./transcribe')
const { sendImage, sendVideoFile, sendFile } = require('./upload')
const wsServer = require('./ws-server')
const { DaemonLifecycle, isAuthCommand } = require('./daemon-lifecycle')
const { createUiController } = require('./ui-control')
const { createManagementBridge } = require('./ui-bridge')
const WECHAT_BRO_VERSION = require('../package.json').version

// Overridable for tests so unit suites never touch the real ~/.wechat-bro
const DATA_DIR = process.env.WECHAT_BRO_DATA_DIR || path.join(os.homedir(), '.wechat-bro')
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.jsonl')
const CONTACTS_DIR = path.join(DATA_DIR, 'contacts')

const WX_URL = 'https://wx.qq.com'
const INJECT_SCRIPT = fs.readFileSync(path.join(__dirname, 'wechat-bro.js'), 'utf-8')
const INJECT_UI_SCRIPT = fs.readFileSync(path.join(__dirname, 'wechat-ui.js'), 'utf8')
const HEADED = process.argv.includes('--headed')
const QUIET = process.argv.includes('--quiet') || !process.stdin.isTTY
const LOGIN_TIMEOUT = 300_000

// WebHelm owns Chrome, cookies and profile.
function toLoginUrl(qrUrl) {
  if (!qrUrl || typeof qrUrl !== 'string') return null
  return qrUrl.replace('/qrcode/', '/l/')
}

let lastQrUrl = null
let lastQrPayload = null
let chromePath = null  // used only by media renderers
let _wsBroadcast = null  // set by main() for event broadcasting

// ── Persist binary content (base64) in events to disk → file path ────────
// Fields with binary content and their file extension. When present in an
// event's data, the base64 is decoded and written to the owning contact's
// own download folder, and the field is replaced with the file path so
// events stay small & agent-friendly.
const BINARY_FIELDS = {
  voiceBase64: { ext: 'amr', mime: 'audio' },
  imageBase64: { ext: 'jpg', mime: 'image' },
  videoBase64: { ext: 'mp4', mime: 'video' },
}

/** Make an arbitrary contact name / filename safe as a single path segment.
 *  Strips separators + control chars (blocks path traversal); CJK is kept. */
function sanitizeFsName(name) {
  const s = String(name || '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  return (s || 'unknown').slice(0, 120)
}

/** Per-contact download folder: <DATA_DIR>/contacts/<contact name>/download/ */
function contactDownloadDir(contactName) {
  return path.join(CONTACTS_DIR, sanitizeFsName(contactName), 'download')
}

/** The chat-side contact that owns a message's media. For room messages this
 *  is the room (from is the room name); for self-sent (from=me) it's the peer. */
function messageContact(data) {
  if (data && typeof data.from === 'string' && data.from && data.from !== 'me') return data.from
  if (data && typeof data.to === 'string' && data.to && data.to !== 'me') return data.to
  return 'unknown'
}

function saveBinaryContent(data) {
  if (!data || typeof data !== 'object') return
  for (const [field, { ext }] of Object.entries(BINARY_FIELDS)) {
    const b64 = data[field]
    if (!b64 || typeof b64 !== 'string') continue
    try {
      const buf = Buffer.from(b64, 'base64')
      if (buf.length === 0) continue
      const dir = contactDownloadDir(messageContact(data))
      fs.mkdirSync(dir, { recursive: true })
      // <filename>_<MsgId>.<ext> — MsgId keeps filenames stable & dedup-friendly
      const id = data.MsgId || String(Date.now())
      let stem = sanitizeFsName(field.replace('Base64', '')) // voice/image/video
      let fileExt = ext
      const orig = typeof data.FileName === 'string' ? data.FileName.trim() : ''
      if (orig) {
        stem = sanitizeFsName(orig.replace(/\.[^.]*$/, '')) // original name, ext re-derived below
        const origExt = path.extname(orig).replace('.', '').toLowerCase()
        if (origExt) fileExt = origExt
      }
      const file = path.join(dir, stem + '_' + id + '.' + fileExt)
      fs.writeFileSync(file, buf)
      delete data[field]
      data[field.replace('Base64', 'File')] = file
      log('saved binary:', file, '(' + buf.length + ' bytes)')
    } catch (e) {
      log('saveBinaryContent error for', field + ':', e.message)
    }
  }
}

// ── Simplify message events ──────────────────────────────────────────────
// Agents don't want WeChat's raw wire-format blobs. Non-text message events
// are distilled into a small object whose `content` is the most useful
// representation — a local file path for media, extracted url for emoticons,
// readable text for system-ish messages. Text messages (MsgType 1) keep their
// raw shape. On ALL message events every empty field (null/''/[]) is stripped.
// Returns false for suppressed types (app/system/recalled) — the caller must
// not send those events at all.
const EVENT_MSG_TYPE_NAMES = {
  3: 'image', 34: 'voice', 37: 'verify', 42: 'card',
  43: 'video', 47: 'emoticon', 48: 'location', 49: 'app',
  51: 'status', 62: 'microvideo', 10000: 'system', 10002: 'recalled',
}
// Message types never emitted to agents (XML wire noise, no agent value).
const SUPPRESSED_MSG_TYPES = new Set(['app', 'system', 'recalled'])

function stripHtml(s) {
  return String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim()
}

/** Drop empty fields (undefined/null/''/[]) so events stay compact. */
function stripEmptyFields(data) {
  if (!data || typeof data !== 'object') return
  for (const k of Object.keys(data)) {
    const v = data[k]
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) delete data[k]
  }
}

function simplifyMessageEvent(event, data) {
  if (!data || typeof data !== 'object') return true
  if (!/^message(:|$)/.test(event)) return true
  // Text messages pass through raw, minus empty-field noise
  if (data.MsgType === 1) {
    stripEmptyFields(data)
    return true
  }
  const type = EVENT_MSG_TYPE_NAMES[data.MsgType] || 'unknown'
  if (SUPPRESSED_MSG_TYPES.has(type)) return false

  const simplified = {
    MsgId: data.MsgId,
    from: data.from,
    to: data.to,
    sender: data.sender,
    mentions: data.mentions,
    mentionMe: data.mentionMe,
    ts: data.CreateTime,
    type,
  }
  switch (type) {
    case 'image':
      simplified.content = data.imageFile || '[image download failed]'
      break
    case 'voice':
      simplified.content = data.voiceText || data.voiceFile || '[voice message]'
      if (data.voiceFile) simplified.voiceFile = data.voiceFile
      break
    case 'video':
    case 'microvideo':
      simplified.content = data.videoFile ||
        `[video not downloaded: ${data.FileName || type}${data.FileSize ? ' ' + data.FileSize + 'B' : ''}]`
      break
    case 'emoticon':
      simplified.content = data.emojiUrl || '[emoticon]'
      break
    case 'location':
      simplified.content = data.location || stripHtml(data.Content) || '[location]'
      break
    case 'card':
      simplified.content = data.cardName ? `[contact card: ${data.cardName}]` : '[contact card]'
      break
    default: // verify/status/unknown — keep readable text
      simplified.content = stripHtml(data.Content) || `[${type}]`
  }

  stripEmptyFields(simplified)
  for (const k of Object.keys(data)) delete data[k]
  Object.assign(data, simplified)
  return true
}

// ── Save scan event's user avatar → ~/.wechat-bro/userAvatar.png ─────────
// Replaces data.userAvatar (URL) with the file path synchronously so the
// event always carries a path; the actual bytes are downloaded async.
const USER_AVATAR_FILE = path.join(DATA_DIR, 'userAvatar.png')

function saveUserAvatar(data) {
  if (!data || typeof data !== 'object') return
  const avatarUrl = data.userAvatar
  if (!avatarUrl || typeof avatarUrl !== 'string') return

  // Inline base64 data URI (data:img/jpeg;base64,...) — decode synchronously,
  // no fetch needed. WeChat sends the scanned-event avatar this way.
  if (avatarUrl.startsWith('data:')) {
    try {
      const commaIdx = avatarUrl.indexOf(',')
      if (commaIdx < 0) return
      // Header looks like "data:img/jpeg;base64" — only base64 is supported.
      const header = avatarUrl.slice(5, commaIdx) // "img/jpeg;base64"
      if (!/;\s*base64\s*$/i.test(header)) return
      const buf = Buffer.from(avatarUrl.slice(commaIdx + 1), 'base64')
      if (buf.length === 0) return
      fs.writeFileSync(USER_AVATAR_FILE, buf)
      data.userAvatar = USER_AVATAR_FILE
      log('saved user avatar (data URI):', USER_AVATAR_FILE, '(' + buf.length + ' bytes)')
    } catch (e) {
      log('saveUserAvatar data URI error:', e.message)
    }
    return
  }

  // Resolve relative avatar URLs (e.g. /cgi-bin/mmwebwx-bin/webwxgeticon?...)
  let fullUrl = avatarUrl
  if (fullUrl.startsWith('/')) {
    try {
      const u = new URL(WX_URL)
      fullUrl = u.origin + fullUrl
    } catch { return }
  }
  if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://')) return

  // Replace URL with deterministic file path in the event (before write(line))
  data.userAvatar = USER_AVATAR_FILE

  // Async download — populate the file
  fetch(fullUrl, { redirect: 'follow', signal: AbortSignal.timeout(10000) })
    .then((res) => {
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.arrayBuffer()
    })
    .then((buf) => {
      if (!buf || buf.byteLength === 0) return
      fs.writeFileSync(USER_AVATAR_FILE, Buffer.from(buf))
      log('saved user avatar:', USER_AVATAR_FILE, '(' + buf.byteLength + ' bytes)')
    })
    .catch((e) => {
      log('saveUserAvatar error:', e.message)
    })
}

// ── Write JSON to stdout (with newline) + broadcast to WebSocket ──────────
function write(obj) {
  // --quiet: events only. Without it, everything (events + responses) is written.
  if (QUIET && !(obj && obj.event)) return
  process.stdout.write(JSON.stringify(obj) + '\n')
  // Broadcast events (not responses) to WebSocket clients
  if (_wsBroadcast && obj && obj.event) {
    _wsBroadcast(obj)
  }
}

function log(...args) {
  // WECHAT_BRO_LOG=1: detached (non-TTY) children (e.g. the orchestrator's
  // daemon child) keep writing [cli] lines into their log file for debugging.
  if (QUIET && !process.env.WECHAT_BRO_LOG) return
  process.stderr.write(`[cli] ${args.join(' ')}\n`)
}

// ── Graceful shutdown ─────────────────────────────────────────────────────
let _wsServer = null  // set by main()
let _exitSave = null  // set by main(): flush cookies to disk before exit
let _lifecycle = null  // daemon-owned auth/lifecycle state
let _releaseBrowser = null
let _markDaemonStopping = null

let _shutdownPromise = null
function shutdown() {
  if (_shutdownPromise) return _shutdownPromise
  if (_markDaemonStopping) _markDaemonStopping()
  log('Shutting down...')
  if (_lifecycle) { try { _lifecycle.stop() } catch {} }
  if (_exitSave) { try { _exitSave() } catch {} }
  if (_wsServer) { try { _wsServer.close() } catch {} }
  // The asynchronous Group delete must finish BEFORE process exit. A fixed
  // short process.exit timer leaked the Workspace while CDP was busy.
  _shutdownPromise = _releaseBrowser
    ? Promise.resolve().then(() => _releaseBrowser())
    : Promise.resolve()
  return _shutdownPromise
}
function onShutdownSignal() {
  shutdown().then(() => process.exit(0)).catch(error => {
    log('WeChat Group cleanup failed:', error.message)
    process.exit(1)
  })
}
process.on('SIGINT', onShutdownSignal)
process.on('SIGTERM', onShutdownSignal)

// WebHelm persists its own Chrome profile. Never export login cookies here.
async function saveCookies() {}
async function saveCookiesOnExit() {}

// ── CLI command parser ────────────────────────────────────────────────────
// ── Port resolution (--port, --port=N, backward-compat --ws-port) ───────
function extractPort(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port' || a === '--ws-port') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1]
    } else if (a.startsWith('--port=')) {
      return a.split('=')[1]
    } else if (a.startsWith('--ws-port=')) {
      return a.split('=')[1]
    }
  }
  return null
}

/**
 * Parse a command from positional CLI args (not starting with --).
 * Returns null when no command is given (plain daemon mode).
 *
 * Examples:
 *   npx wechat-bro status          → { cmd: 'status' }
 *   npx wechat-bro send-text --to a --content "hi"  → { cmd: 'send-text', to: 'a', content: 'hi' }
 */
function parseCliCommand() {
  const args = process.argv.slice(2)
  const knownFlags = new Set(['--headed', '--quiet', '--daemon', '--pretty'])
  const positional = []
  for (let i = 0; i < args.length; i++) {
    if (knownFlags.has(args[i])) continue
    // Skip --port/--ws-port and its value
    if (args[i] === '--port' || args[i] === '--ws-port') {
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) i++
      continue
    }
    if (args[i].startsWith('--port=') || args[i].startsWith('--ws-port=')) continue
    positional.push(args[i])
  }
  if (positional.length === 0) return null

  const request = { cmd: positional[0] }
  if (['watch', 'unwatch', 'pause', 'resident'].includes(request.cmd) && positional[1] && !positional[1].startsWith('--')) {
    request.context = positional[1]
  }
  if (['pause', 'resident'].includes(request.cmd) && positional[2] && !positional[2].startsWith('--')) {
    request.state = positional[2]
  }
  for (let i = 1; i < positional.length; i++) {
    const arg = positional[i]
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      if (eqIdx !== -1) {
        request[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1)
      } else {
        const key = arg.slice(2)
        if (i + 1 < positional.length && !positional[i + 1].startsWith('--')) {
          request[key] = positional[++i]
        } else {
          request[key] = true
        }
      }
    }
  }
  return request
}

/**
 * Send one command via WebSocket, print the response, then exit.
 */
async function sendCommandViaWs(ws, request) {
  const id = request.id || 'cli-cmd'
  request.id = id

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.id === id) {
      if (request.cmd === 'barcode' && msg.ok) {
        const payload = msg.data || {}
        const url = payload.loginUrl || payload.url
        if (url) {
          process.stdout.write('Scan this WeChat QR code:\n')
          qrcode.generate(url, { small: true })
          process.stdout.write(`\nLogin URL: ${url}\n`)
        }
        ws.close()
        process.exit(0)
      }
      process.stdout.write(JSON.stringify(msg, null, process.argv.indexOf('--pretty') !== -1 ? 2 : 0) + '\n')
      ws.close()
      process.exit(['host', 'watch', 'unwatch', 'pause', 'resident'].includes(request.cmd) && msg.ok === false ? 1 : 0)
    }
  })

  ws.on('close', () => {
    if (!process.exitCode) process.exit(1)
  })

  // Safety timeout
  const timeoutMs = request.cmd === 'send-video' ? 1800000 : request.cmd === 'send-voice' ? (parseInt(process.env.WHISPER_TIMEOUT || '120000', 10) + 60000) : 30000
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ ok: false, error: 'timeout', id }) + '\n')
    ws.close()
    process.exit(1)
  }, timeoutMs)

  ws.send(JSON.stringify(request))
}

// ── Try connecting to existing daemon (client mode) ──────────────────────
/**
 * Connect to an existing daemon's WebSocket.
 * If `request` is provided, sends that single command and exits.
 * If `request` is null, relays stdin lines as commands (pipe mode).
 * Returns true if connection succeeded (caller should exit).
 */
async function tryConnectAsClient(port, request) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    const timeout = setTimeout(() => {
      ws.close()
      resolve(false)
    }, 2000)

    ws.on('open', () => {
      clearTimeout(timeout)
      if (request) {
        sendCommandViaWs(ws, request)
      } else {
        runClientMode(ws)
      }
      resolve(true)
    })

    ws.on('error', () => {
      clearTimeout(timeout)
      resolve(false)
    })
  })
}

/**
 * Read stdin, send each command via WebSocket to the daemon,
 * print the JSON response to stdout, then exit.
 */
async function runClientMode(ws) {
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  const pending = new Map()
  let nextId = 1

  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    // Match response to pending request
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      clearTimeout(p.timeout)
      pending.delete(msg.id)
      p.resolve(msg)
    }
    // Ignore broadcast events (no matching request id)
  })

  ws.on('close', () => {
    // Reject all pending requests so the process doesn't hang
    for (const [id, p] of pending) {
      clearTimeout(p.timeout)
      pending.delete(id)
      p.reject(new Error('daemon disconnected'))
    }
  })

  try {
    for await (const line of rl) {
      if (!line.trim()) continue

      const id = `stdin-${nextId++}`
      let req
      try { req = JSON.parse(line) } catch {
        process.stdout.write(JSON.stringify({ ok: false, error: 'invalid json', id: null }) + '\n')
        continue
      }
      req.id = id

      const response = await new Promise((resolve, reject) => {
        const timeoutMs = req.cmd === 'send-video' ? 1800000 : 30000
        const timeout = setTimeout(() => reject(new Error('timeout')), timeoutMs)
        pending.set(id, { resolve, reject, timeout })
        ws.send(JSON.stringify(req))
      })

      process.stdout.write(JSON.stringify(response) + '\n')
    }
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: e.message, id: null }) + '\n')
  }

  ws.close()
  process.exit(0)
}

// ── Help / version ────────────────────────────────────────────────────────
function printHelp() {
  const help = `wechat-bro — AI agent interface for WeChat Web

Usage:
  wechat-bro                        Start daemon in foreground (WebSocket ws://localhost:9231)
  wechat-bro --daemon               Start daemon explicitly (same as above)
  wechat-bro <command> [--flags]    Run one command via the running daemon
                                    (error if no daemon is running)
  wechat-bro --help                 Show this help
  wechat-bro --version              Show version
  wechat-bro doctor                 Verify WebHelm service/Chrome dependency without launching WeChat

Flags:
  --headed          Show browser window (default: headless)
  --port <port>     WebSocket port (default: 9231, env WS_PORT)
  --daemon          Run as daemon (serve WebSocket clients)
  --quiet           Events-only output on stdout (suppress other stdout noise)
  --pretty          Pretty-print command responses (JSON with 2-space indent)

Modes:
  orchestrator [--port <port>] [--harness <tpl|name>] [--daemon]
                               Start the orchestrator (own long-lived process):
                               watch contacts declared in ~/.wechat-bro/agents/
                               *.md frontmatter and dispatch each message
                               to a resumable harness CLI task (harness names:
                               pi | claude | codex | copilot — default pi;
                               or a custom template; override every agent
                               with --harness) rooted in the contact's own
                               folder. If no daemon is running, one is
                               spawned as a child process (dies with the
                               orchestrator); --daemon forces that even when
                               one is already running. User guidance arrives
                               via filehelper. Falls back to package defaults
                               for missing agent mds; edits apply on the next
                               message.

  exit                         Stop orchestrator, then daemon (graceful).

Commands:
  contacts                     List individual contacts (names only)
  rooms                        List group chats (names only)
  room-members --name <room>   List members of a room (names only)
  get-contact --name <name>    Get details for a contact OR room
  send-text --to <name> --content <text>
                               Send a text message. @\\"name\\" = mention in rooms.
                               Marpit/mermaid code blocks are auto-rendered.
  host --to <name> --prompt <rich context>
                               Ask the running orchestrator to host a discussion.
  watch <contact-or-room-name> [--agent <agent-name>] [--mode maintainer|assistant]
                               Persistently watch an exact WeChat contact/room name.
                               --agent is optional; otherwise reuse/select the routed agent.
                               --mode is optional; default: maintainer.
  unwatch <contact-or-room-name>
                               Persistently unwatch and immediately stop routing.
  pause <contact-or-room-name> <on|off>
                               Runtime-only pause/resume; restart clears it.
  resident <contact-or-room-name> <on|off>
                               Runtime-only Codex app-server resident mode.
  send-image --to <name> --path <file> [--filename <name>]
  send-video --to <name> --path <file> [--filename <name>]
  send-file  --to <name> --path <file> --filename <name>
  send-voice --to <name> --path <file>   (transcribe + send as text)
  barcode                      Render the current login QR in this terminal
  status                       Show orchestrator watch/runtime state and daemon health
  emojis                       List supported emoji codes
  config --key <k> --value <v> Set a config option
  exit                         Shut down the daemon

Events stream to stdout as JSON lines; messages also appended to
~/.wechat-bro/messages.jsonl. Binary media is saved per contact:
~/.wechat-bro/contacts/<contact name>/download/<filename>_<id>.<ext>.
`
  process.stdout.write(help)
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp()
    process.exit(0)
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    let version = '0.0.0'
    try { version = require('../package.json').version } catch {}
    process.stdout.write(version + '\n')
    process.exit(0)
  }

  if (argv[0] === 'doctor') {
    const info = await resolveEndpoint()
    process.stdout.write(JSON.stringify({
      ok: true, dependency: 'webhelm', version: info.version,
      endpoint: info.endpoint, profile: info.profile,
    }) + '\n')
    return
  }

  const WS_PORT = parseInt(process.env.WS_PORT || extractPort(argv) || '9231', 10)
  const cliRequest = parseCliCommand()
  const forceDaemon = argv.includes('--daemon')

  // `orchestrator` is a LOCAL mode (its own long-lived process): connect to
  // the daemon as a WS client and dispatch watched-contact messages to
  // harness tasks configured via *.agent.md frontmatter.
  const firstPosArg = argv.find(a => !a.startsWith('--'))
  if (firstPosArg === 'orchestrator') {
    const { runOrchestrator } = require('./orchestrator')
    await runOrchestrator({ port: WS_PORT })
    return
  }

  // `exit` is a shutdown command — it must NEVER spin up a new daemon.
  // Try to reach an existing one and shut it down; if none is running,
  // report success (nothing left to do) and exit without launching Chrome.
  if (cliRequest && cliRequest.cmd === 'exit') {
    const connected = await tryConnectAsClient(WS_PORT, cliRequest)
    if (!connected) {
      process.stdout.write(JSON.stringify({
        ok: true,
        id: null,
        data: { shuttingDown: true, daemonRunning: false },
      }) + '\n')
    }
    return
  }

  // ── Client mode: any CLI command or piped stdin goes through an EXISTING
  // daemon. Never auto-starts one — print an error telling the user how.
  if (!forceDaemon && (cliRequest || !process.stdin.isTTY)) {
    const connected = await tryConnectAsClient(WS_PORT, cliRequest || undefined)
    if (connected) return
    process.stdout.write(JSON.stringify({
      ok: false,
      id: null,
      error: `no daemon running on port ${WS_PORT} — start one first: wechat-bro --daemon --port ${WS_PORT}`,
    }) + '\n')
    process.exit(1)
  }

  // ── Daemon mode (foreground `--daemon` / plain TTY run, or background
  // spawn). Chrome + WebSocket server; serves all clients until `exit`.
  fs.mkdirSync(DATA_DIR, { recursive: true })

  chromePath = findSystemChrome()
  log('Browser: managed by WebHelm (WeChat group)')

  // Commands that arrive before the page is injected/initiated wait on this
  // promise (see _markPageReady below), instead of failing with
  // "dispatch not ready".
  let _markPageReady
  const pageReady = new Promise((resolve) => { _markPageReady = resolve })
  let wsDispatch = async (cmd, args) => { await pageReady; return wsDispatch(cmd, args) }

  const ws = wsServer.create({
    port: WS_PORT,
    quiet: QUIET,
    dispatch: (cmd, args) => wsDispatch(cmd, args),
  })
  _wsBroadcast = ws.broadcast
  _wsServer = ws

  // Fail fast if the port is taken (another daemon is already running),
  // instead of launching Chrome on top of a dead WebSocket server.
  try {
    await ws.ready
    log(`WebSocket server: ws://localhost:${WS_PORT}`)
  } catch (e) {
    const msg = (e && (e.message || String(e))) || ''
    if ((e && e.code === 'EADDRINUSE') || /EADDRINUSE/.test(msg)) {
      console.error(`[cli] Port ${WS_PORT} already in use — another wechat-bro daemon is likely running. Exiting.`)
    } else {
      console.error(`[cli] WebSocket server failed to start: ${msg}`)
    }
    process.exit(1)
  }

  let browser = await WebHelmBrowser.open({ url: 'about:blank', headed: HEADED, dataDir: DATA_DIR, allowOrphanRecovery: true })
  let page = (await browser.pages())[0]
  _releaseBrowser = () => browser.close()
  let bootstrapping = true
  let daemonStopping = false
  _markDaemonStopping = () => { daemonStopping = true }
  const uiController = createUiController({dataDir: DATA_DIR, port: WS_PORT})
  let msgFd
  try { msgFd = fs.openSync(MESSAGES_FILE, 'a') } catch {}

  // The lifecycle controller deliberately lives outside the replaceable page
  // context. Navigation/reinjection must not erase the daemon's knowledge that
  // the previous page was authenticated.
  const lifecycle = new DaemonLifecycle({
    log,
    emit: write,
    flush: () => saveCookies(page),
    recoverPage: (reason) => reconnectBrowser(reason),
  })
  _lifecycle = lifecycle
  lifecycle.setPage(page).start()

  async function handleBrowserEvent(event, data) {
    lifecycle.handleBridgeEvent(event)
    if (data && data.voiceBase64 && (event === 'message:voice' || (event === 'message' && data.MsgType === 34))) {
      await transcribeVoiceAsync(data)
    }
    saveBinaryContent(data)
    if (!simplifyMessageEvent(event, data)) return
    if (event === 'scan') saveUserAvatar(data)
    const line = { event, data, ts: Date.now() }
    write(line)
    if ((event === 'message' || event.startsWith('message:')) && msgFd) {
      try { fs.writeSync(msgFd, JSON.stringify(line) + '\n') } catch {}
    }
    if (event === 'scan' && data) {
      // Report QR but never open login tabs or attempt login without user action.
      lastQrPayload = data
      lastQrUrl = data.url || null
    }
  }

  function wireBrowser(nextBrowser) {
    nextBrowser.on('heartbeat-error', (error) => log('WebHelm heartbeat:', error.message))
    nextBrowser.on('disconnected', () => {
      if (!daemonStopping && nextBrowser === browser) lifecycle.pageLost('browser disconnected')
    })
  }

  const managementUi = createManagementBridge({
    controller: uiController,
    source: INJECT_UI_SCRIPT,
    isActive: target => !daemonStopping && target === page,
    log,
  })

  async function mountManagementUi(nextPage) {
    // Management UI is an optional surface: a rendering or browser CSP
    // failure must never prevent normal messaging and agent dispatch.
    try { await managementUi.mount(nextPage) }
    catch (error) { log('Management UI mount unavailable:', error.message) }
  }

  async function wirePage(nextPage) {
    try { await managementUi.attach(nextPage) }
    catch (error) { log('Management UI bridge unavailable:', error.message) }
    nextPage.on('dialog', async (dialog) => { log('Dialog:', dialog.message()); await dialog.accept() })
    nextPage.on('framenavigated', async (frame) => {
      if (daemonStopping || bootstrapping || nextPage !== page || frame !== nextPage.mainFrame() || !frame.url().includes('wx.qq.com')) return
      lifecycle.pageReplaced(nextPage, 'page navigation')
      log('Page navigated — re-injecting')
      try {
        await nextPage.waitForFunction(() => typeof angular !== 'undefined' && angular.element(document).injector(), { timeout: 15000 })
        await nextPage.evaluate(INJECT_SCRIPT)
        await nextPage.evaluate(() => { if (window.WechatyBro && !window.WechatyBro.vars.initState) return window.WechatyBro.init(); return { code: 304 } })
        await nextPage.evaluate(() => { if (window.WechatyBro) window.WechatyBro._loadLastMsgTime() })
        await lifecycle.revalidate('page re-injected')
        await mountManagementUi(nextPage)
      } catch (e) { log('Re-inject failed:', e.message) }
    })
    nextPage.on('error', (error) => {
      if (!daemonStopping && nextPage === page) lifecycle.pageLost('page error', { error: error.message })
    })
    nextPage.on('close', () => {
      if (!daemonStopping && nextPage === page) lifecycle.pageLost('page closed')
    })
    await nextPage.exposeFunction('sendToWebHelm', handleBrowserEvent)
  }

  async function reconnectBrowser(reason) {
    const oldBrowser = browser
    const oldPage = page
    bootstrapping = true
    page = null
    browser = null
    try { await oldBrowser.close() } catch {}
    browser = await WebHelmBrowser.open({ url: 'about:blank', headed: HEADED, dataDir: DATA_DIR, allowOrphanRecovery: true })
    _releaseBrowser = () => browser.close()
    page = (await browser.pages())[0]
    lifecycle.setPage(page)
    wireBrowser(browser)
    await wirePage(page)
    await page.goto(WX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForFunction(() => typeof angular !== 'undefined' && angular.element(document).injector(), { timeout: 30000 })
    await page.evaluate(INJECT_SCRIPT)
    await page.evaluate(() => { if (window.WechatyBro && !window.WechatyBro.vars.initState) return window.WechatyBro.init(); return { code: 304 } })
    await page.evaluate(() => { if (window.WechatyBro) window.WechatyBro._loadLastMsgTime() })
    await mountManagementUi(page)
    bootstrapping = false
    log('Browser/page recovered after', reason)
    return page
  }

  wireBrowser(browser)
  await wirePage(page)

  await page.goto(WX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => typeof angular !== 'undefined' && angular.element(document).injector(), { timeout: 30000 })
  log('Angular ready')

  await page.evaluate(INJECT_SCRIPT)
  const initResult = await page.evaluate(() => {
    if (window.WechatyBro && !window.WechatyBro.vars.initState) return window.WechatyBro.init()
    return { code: 304 }
  })
  log('Init:', initResult.code, initResult.message)

  // Unauthenticated is a normal, intentional state. Do not block waiting
  // for QR or contacts; serve status and fail fast on authenticated commands.
  const isLoggedIn = await page.evaluate(() => !!(window.MMCgi && window.MMCgi.isLogin))
  if (isLoggedIn) {
    log('Already logged in')
    try { await page.waitForFunction(() => window.WechatyBro && window.WechatyBro.vars.contactsReady === true, { timeout: 120_000 }) } catch {}
  } else { log('login_required: user has not signed in') }
  await mountManagementUi(page)
  bootstrapping = false
  await lifecycle.revalidate('startup ready')

  // Emit a "ready" event so the agent knows it can start sending commands
  write({ event: 'ready', data: lifecycle.readyData(!!(lifecycle.lastSignals && lifecycle.lastSignals.contactsReady)) })

  // ── Wire up WebSocket dispatch (now that page is ready) ───────────────
  wsDispatch = async (cmd, args) => {
    if (cmd === 'exit') {
      // Return a result so ws-server flushes {ok:true} back to the requesting
      // client, then tear down the browser + process on the next tick
      // (cookie flush + browser.close() give the socket time to flush the reply).
      daemonStopping = true
      lifecycle.stop()
      setImmediate(async () => {
        try { await browser.close(); process.exit(0) }
        catch (error) { log('WeChat Group deletion failed:', error.message); process.exit(1) }
      })
      return { shuttingDown: true }
    }
    if (isAuthCommand(cmd)) lifecycle.requireAuthenticated()
    return dispatch(cmd, args, page)
  }

  // Page is injected + logged in (or login timed out) — flush queued commands.
  _markPageReady()

  log('Daemon ready — serving WebSocket clients on ws://localhost:' + WS_PORT)
  
  // Daemon stays alive until `exit` command, SIGINT or SIGTERM.
  // (No stdin reader: background-spawned daemons have no stdin.)
}

// ── Send text with @mention conversion (shared helper) ──────────────────
async function sendText(page, to, content) {
  return page.evaluate((to, content) => {
    const WB = window.WechatyBro
    // Strict resolve — throws on ambiguous/unknown recipient (fail fast, before
    // any mention rewriting), so the agent gets a clear disambiguation error.
    const resolved = WB._requireUserName(to)
    const isRoom = resolved.startsWith('@@')
    // @mention conversion: agent writes @"<contact name>" (quoted, whitespace-safe).
    // We resolve the name → UserName and render WeChat's @<DisplayName>\u2005.
    // Unknown names are left untouched (agent may have meant a literal @). Names
    // containing a literal `"` cannot be represented — extremely rare in WeChat.
    content = content.replace(/@"([^"]+)"/g, (match, name) => {
      const un = WB._resolveUserName(name)
      if (!un) return match
      const mention = isRoom ? WB.at(un, resolved) : WB.at(un)
      return mention || match
    })
    return WB.send(to, content, true)
  }, to, content)
}

// ── Parse content into segments ─────────────────────────────────────────
// Returns [{ type: 'text'|'marpit'|'mermaid', content: string }]
function parseSegments(content) {
  const segs = []
  let remaining = content
  while (remaining.length) {
    // Find the next fenced block (marpit or mermaid) at line start
    let best = null
    for (const lang of ['marpit', 'mermaid']) {
      const fence = '```' + lang + '\n'
      // Only match at position 0 or after a newline
      let idx = -1
      if (remaining.startsWith(fence)) {
        idx = 0
      } else {
        idx = remaining.indexOf('\n' + fence)
        if (idx !== -1) idx += 1  // point to the fence itself
      }
      if (idx !== -1 && (best === null || idx < best.idx)) {
        best = { idx, lang, fenceLen: fence.length }
      }
    }
    if (!best) break  // no more blocks

    // Text before the block
    if (best.idx > 0) {
      const before = remaining.slice(0, best.idx).trim()
      if (before) segs.push({ type: 'text', content: before })
    }

    // The block itself
    const blockStart = best.idx + best.fenceLen
    const endIdx = remaining.indexOf('```', blockStart)
    if (endIdx === -1) { // unclosed fence → treat rest as text
      segs.push({ type: 'text', content: remaining.slice(best.idx).trim() })
      remaining = ''
      break
    }
    segs.push({ type: best.lang, content: remaining.slice(blockStart, endIdx).trim() })
    remaining = remaining.slice(endIdx + 3)
  }
  // Trailing text
  const trail = remaining.trim()
  if (trail) segs.push({ type: 'text', content: trail })
  return segs
}

// ── Command dispatcher ────────────────────────────────────────────────────
async function dispatch(cmd, args, page) {
  // Optional live-test safety boundary. Normal production has no allowlist.
  const allowed = process.env.WECHAT_BRO_ALLOWED_RECIPIENTS
  const outbound = new Set(['send', 'send-text', 'send-image', 'send-video', 'send-file', 'send-voice'])
  if (allowed && outbound.has(cmd)) {
    const whitelist = new Set(allowed.split(',').map(x => x.trim()).filter(Boolean))
    if (!whitelist.has(String(args.to || ''))) throw new Error('test_recipient_not_allowed')
  }
  switch (cmd) {
    case 'barcode':
    case 'qr':
    case 'get-barcode':
      if (!lastQrPayload || !lastQrPayload.url) {
        throw new Error('No login QR is currently available (the account may already be logged in)')
      }
      return lastQrPayload

    case 'contacts':
      // Individuals only (isContact===true, not a room). Names only.
      return page.evaluate(() =>
        window.WechatyBro.contactList(c => c.isContact && c.isContact() === true && !(c.isRoomContact && c.isRoomContact()))
          .map(c => c.name)
      )

    case 'rooms':
      // Group chats only. Names only.
      return page.evaluate(() =>
        window.WechatyBro.contactList(a => a.isRoomContact && a.isRoomContact() === true)
          .map(r => r.name)
      )

    case 'room-members':
      if (!args.name) throw new Error('Missing --name (room name)')
      // Names only.
      const _members = await page.evaluate((rid) => window.WechatyBro.getRoomMembers(rid), args.name)
      return _members.map(m => m.name)

    case 'get-contact':
      // Works for any contact OR room (resolved by name).
      if (!args.name) throw new Error('Missing --name (contact or room name)')
      return page.evaluate((cid) => window.WechatyBro.getContact(cid), args.name)

    case 'send-text':
    case 'send':   // backward-compat alias
      if (!args.to) throw new Error('Missing --to')
      if (!args.content) throw new Error('Missing --content')

      // ── Parse content into segments ──────────────────────────────────
      const segs = parseSegments(args.content)
      const renderable = segs.filter(s => s.type === 'marpit' || s.type === 'mermaid')

      if (renderable.length === 0) {
        // Plain text — no blocks to render
        if (!await sendText(page, args.to, args.content)) throw new Error('WeChat send-text was not accepted')
        return true
      }

      // ── Render each block, collect text segments ─────────────────────
      let marpitN = 0, mermaidN = 0
      const files = []
      const captionParts = []
      const tmpDirs = []

      for (const seg of segs) {
        if (seg.type === 'text') {
          captionParts.push(seg.content)
          continue
        }

        if (seg.type === 'marpit') {
          marpitN++
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-marpit-'))
          tmpDirs.push(tmpDir)
          const mdFile = path.join(tmpDir, 'slides.md')
          const outFile = path.join(tmpDir, 'slides.pdf')
          const fname = marpitN === 1 ? 'slides.pdf' : `slides-${marpitN}.pdf`
          try {
            fs.writeFileSync(mdFile, seg.content)
            // --pdf: WeChat cannot display HTML; PDF is universally viewable.
            // Reuse the detected Chrome (same as mermaid) so we don't download
            // a separate Chromium just for marp.
            execSync(`npx @marp-team/marp-cli --pdf --chrome-path "${chromePath}" "${mdFile}" -o "${outFile}"`, {
              timeout: 30000,
              stdio: 'pipe',
              env: { ...process.env, PUPPETEER_EXECUTABLE_PATH: chromePath, CHROME_PATH: chromePath },
            })
            const pdfBuf = fs.readFileSync(outFile)
            if (!await sendFile(page, args.to, pdfBuf, fname)) throw new Error('WeChat document send not accepted')
            files.push({ file: fname, type: 'marpit' })
          } catch (e) {
            throw new Error(`marpit render failed: ${e.message}`)
          }
        }

        if (seg.type === 'mermaid') {
          mermaidN++
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-mermaid-'))
          tmpDirs.push(tmpDir)
          const mmdFile = path.join(tmpDir, 'diagram.mmd')
          const pngFile = path.join(tmpDir, 'diagram.png')
          const fname = mermaidN === 1 ? 'diagram.png' : `diagram-${mermaidN}.png`
          try {
            fs.writeFileSync(mmdFile, seg.content)
            execSync(`npx @mermaid-js/mermaid-cli -i "${mmdFile}" -o "${pngFile}"`, {
              timeout: 120000,
              stdio: 'pipe',
              env: { ...process.env, PUPPETEER_EXECUTABLE_PATH: chromePath },
            })
            const pngBuf = fs.readFileSync(pngFile)
            if (!await sendImage(page, args.to, pngBuf, fname)) throw new Error('WeChat image send not accepted')
            files.push({ file: fname, type: 'mermaid' })
          } catch (e) {
            throw new Error(`mermaid render failed: ${e.message}`)
          }
        }
      }

      // ── Cleanup temp dirs ────────────────────────────────────────────
      for (const d of tmpDirs) try { fs.rmSync(d, { recursive: true }) } catch {}

      // ── Send remaining text ──────────────────────────────────────────
      const caption = captionParts.join('\n\n')
      if (caption && !await sendText(page, args.to, caption)) throw new Error('WeChat caption send not accepted')

      return { sent: true, to: args.to, files, caption: caption || undefined }

    case 'send-image':
      if (!args.to) throw new Error('Missing --to')
      if (!args.path) throw new Error('Missing --path (local file path)')
      if (!fs.existsSync(args.path)) throw new Error(`File not found: ${args.path}`)
      if (!await sendImage(page, args.to, fs.readFileSync(args.path), args.filename || path.basename(args.path))) throw new Error('WeChat send-image was not accepted')
      return { sent: true, to: args.to, file: args.filename || path.basename(args.path) }

    case 'send-video':
      if (!args.to) throw new Error('Missing --to')
      if (!args.path) throw new Error('Missing --path (local video file)')
      if (!fs.existsSync(args.path)) throw new Error(`File not found: ${args.path}`)
      {
        const result = await sendVideoFile(page, args.to, args.path, args.filename || path.basename(args.path))
        return { ...result, to: args.to, file: args.filename || path.basename(args.path) }
      }

    case 'send-file':
      if (!args.to) throw new Error('Missing --to')
      if (!args.path) throw new Error('Missing --path (local file path)')
      if (!args.filename) throw new Error('Missing --filename (shown to recipient)')
      if (!fs.existsSync(args.path)) throw new Error(`File not found: ${args.path}`)
      if (!await sendFile(page, args.to, fs.readFileSync(args.path), args.filename)) throw new Error('WeChat send-file was not accepted')
      return { sent: true, to: args.to, file: args.filename }

    case 'send-voice':
      if (!args.to) throw new Error('Missing --to')
      if (!args.path) throw new Error('Missing --path (local audio file)')
      if (!fs.existsSync(args.path)) throw new Error(`File not found: ${args.path}`)
      log('Transcribing:', args.path)
      const text = await transcribeFileAsync(args.path)
      if (!text) throw new Error('Transcription returned empty result')
      log('Transcribed:', text.slice(0, 80))
      const voiceReply = await page.evaluate((to, content) => {
        const ok = window.WechatyBro.send(to, content, true)
        return { sent: ok, to, transcription: content }
      }, args.to, text)
      if (!voiceReply.sent) throw new Error('WeChat transcribed voice text was not accepted')
      return voiceReply

    case 'status':
    case 'daemon-status': // orchestrator-internal health probe; CLI status is orchestrator-rich
      return page.evaluate(() => ({
        loggedIn: !!window.WechatyBro.vars.loginState,
        contactsReady: !!window.WechatyBro.vars.contactsReady,
        lastMsgTime: window.WechatyBro._lastMsgTime || 0,
        initState: !!window.WechatyBro.vars.initState,
        account: window.WechatyBro.getAccount()
      })).then(data => ({ version: WECHAT_BRO_VERSION, ...data, lifecycle: _lifecycle ? _lifecycle.state : 'page_lost/recovering' }))

    case 'emojis':
    case 'supported-emojis':   // backward-compat alias
      return page.evaluate(() => window.WechatyBro.getSupportedEmojis())

    case 'config':
      if (!args.key) throw new Error('Missing --key')
      if (!args.value) throw new Error('Missing --value')
      return page.evaluate((key, value) => window.WechatyBro.config(key, value), args.key, args.value)

    default:
      throw new Error(`Unknown command: ${cmd}`)
  }
}

// Only auto-run when executed directly (not when required for tests)
if (require.main === module) {
  main().catch(e => {
    // Fatal startup errors must be visible even with --quiet, daemon spawn,
    // or when stdout is reserved for JSON events.
    console.error('[cli] Fatal:', e && e.message || String(e))
    process.exit(1)
  })
}

// Exported for unit tests
module.exports = {
  parseSegments,
  saveBinaryContent,
  simplifyMessageEvent,
}
