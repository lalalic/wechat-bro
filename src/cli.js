#!/usr/bin/env node

/**
 * cli.js — WebSocket + stdin JSON-line interface for AI agents.
 *
 * Runs a single long-lived Chrome process logged into wx.qq.com.
 * Supports multiple agents via WebSocket (ws://localhost:9231).
 * Also reads JSON commands from stdin for backward compatibility.
 *
 * Usage:
 *   node cli.js                    # Headless, WebSocket on :9231
 *   node cli.js --headed           # Show browser
 *   node cli.js --first-login      # Force QR re-login
 *   node cli.js --ws-port 9231     # Custom WebSocket port
 *
 * WebSocket Protocol:
 *   Agent → Server:  {"cmd":"auth","agent":"testneo"}   # optional, identify
 *   Agent → Server:  {"cmd":"contacts","id":"req-1"}    # any command
 *   Server → Agent:  {"ok":true,"id":"req-1","data":[]} # response
 *   Server → Agent:  {"event":"message","data":{},"ts":...} # broadcast event
 *
 * Commands:
 *   contacts          → [{id, name, UserName, isRoomContact, memberCount}]
 *   rooms             → [{id, name, UserName, memberCount}] (rooms only)
 *   room-members      → [{id, name, UserName, ...}]  (args: --id <roomId>)
 *   get-contact       → {id, name, ...}               (args: --id <contactId>)
 *   send              → {sent: true, to}              (args: --to, --content)
 *   send-image        → {sent: true, to, file}        (args: --to, --path, [--filename])
 *   send-file         → {sent: true, to, file}        (args: --to, --path, --filename)
 *   send-voice        → {sent, to, transcription}     (args: --to, --path)
 *   status            → {loggedIn, contactsReady, lastMsgTime}
 *   supported-emojis  → [string]
 *   ping              → {pong: true, ts: ...}         (liveness check)
 *   exit              → shut down
 */

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const readline = require('readline')
const puppeteer = require('puppeteer')
const qrTerm = require('qrcode-terminal')
const WebSocket = require('ws')
const { transcribeVoice, transcribeFile } = require('./transcribe')
const { sendImage, sendFile } = require('./upload')
const wsServer = require('./ws-server')

const DATA_DIR = path.join(os.homedir(), '.wechat-bro')
// Tell puppeteer where to find/store Chromium
process.env.PUPPETEER_CACHE_DIR = path.join(DATA_DIR, 'chromium')

const COOKIE_FILE = path.join(DATA_DIR, 'cookies.json')
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.jsonl')

const WX_URL = 'https://wx.qq.com'
const INJECT_SCRIPT = fs.readFileSync(path.join(__dirname, 'wechat-bro.js'), 'utf-8')
const FIRST_LOGIN = process.argv.includes('--first-login')
const HEADED = process.argv.includes('--headed')
const QUIET = process.argv.includes('--quiet') || !process.stdin.isTTY
const LOGIN_TIMEOUT = 300_000

// ── Chrome detection ──────────────────────────────────────────────────────
async function findChrome() {
  const { platform } = process
  const isWin = platform === 'win32'
  const candidates = [
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Linux
    '/usr/bin/google-chrome', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  for (const p of candidates) if (fs.existsSync(p)) return p
  try {
    const whichCmd = isWin ? 'where' : 'which'
    const nullDev = isWin ? 'nul' : '/dev/null'
    return execSync(`${whichCmd} google-chrome chrome chromium chromium-browser 2>${nullDev}`, { encoding: 'utf-8', shell: true }).trim().split(/\r?\n/)[0]
  } catch {}
  // Fallback: puppeteer's bundled Chromium (auto-downloaded to ~/.wechat-bro/chromium/)
  try {
    const p = typeof puppeteer.executablePath === 'function' ? await puppeteer.executablePath() : puppeteer.executablePath()
    if (p && fs.existsSync(p)) return p
  } catch {}
  log('Chromium not found — downloading (this may take a while)...')
  const browserDir = path.join(DATA_DIR, 'chromium')
  fs.mkdirSync(browserDir, { recursive: true })
  execSync(`npx @puppeteer/browsers install chrome@stable --path "${browserDir}"`, { timeout: 300000, stdio: 'inherit' })
  const p = typeof puppeteer.executablePath === 'function' ? await puppeteer.executablePath() : puppeteer.executablePath()
  if (p && fs.existsSync(p)) return p
  throw new Error('Chromium download failed. Set CHROME_PATH env var.')
}

function toLoginUrl(qrUrl) {
  if (!qrUrl || typeof qrUrl !== 'string') return null
  return qrUrl.replace('/qrcode/', '/l/')
}

let lastQrUrl = null
let chromePath = null  // detected in main(), used by mermaid render
let _wsBroadcast = null  // set by main() for event broadcasting

// ── Write JSON to stdout (with newline) + broadcast to WebSocket ──────────
function write(obj) {
  // In quiet mode (piped stdin), only write command responses, not events
  const isResponse = obj && obj.ok !== undefined
  if (!QUIET || isResponse) {
    process.stdout.write(JSON.stringify(obj) + '\n')
  }
  // Broadcast events (not responses) to WebSocket clients
  if (_wsBroadcast && obj && obj.event) {
    _wsBroadcast(obj)
  }
}

function log(...args) {
  if (QUIET) return
  process.stderr.write(`[cli] ${args.join(' ')}\n`)
}

// ── Graceful shutdown ─────────────────────────────────────────────────────
let _wsServer = null  // set by main()

function shutdown() {
  log('Shutting down...')
  if (_wsServer) {
    try { _wsServer.close() } catch {}
  }
}

process.on('SIGINT', () => { shutdown(); process.exit(0) })
process.on('SIGTERM', () => { shutdown(); process.exit(0) })

// ── Try connecting to existing daemon (client mode) ──────────────────────
/**
 * Connect to an existing daemon's WebSocket and relay stdin commands.
 * Returns true if connection succeeded (caller should exit).
 */
async function tryConnectAsClient(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    const timeout = setTimeout(() => {
      ws.close()
      resolve(false)
    }, 2000)

    ws.on('open', () => {
      clearTimeout(timeout)
      // Connected to existing daemon — enter client mode
      runClientMode(ws)
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
        const timeout = setTimeout(() => reject(new Error('timeout')), 30000)
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

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const WS_PORT = parseInt(process.env.WS_PORT || process.argv.find(a => a.startsWith('--ws-port='))?.split('=')[1] || '9231', 10)

  // When stdin is piped, try connecting to an existing daemon first
  if (!process.stdin.isTTY) {
    const connected = await tryConnectAsClient(WS_PORT)
    if (connected) return // client mode handled everything, we're done
  }

  // No existing daemon — start one (Chrome + WebSocket server)
  fs.mkdirSync(DATA_DIR, { recursive: true })

  chromePath = process.env.CHROME_PATH || await findChrome()
  log('Chrome:', chromePath, HEADED ? '(headed)' : '(headless)')

  let wsDispatch = async () => { throw new Error('dispatch not ready') }
  const ws = wsServer.create({
    port: WS_PORT,
    quiet: QUIET,
    dispatch: (cmd, args) => wsDispatch(cmd, args),
  })
  _wsBroadcast = ws.broadcast
  _wsServer = ws
  log(`WebSocket server: ws://localhost:${WS_PORT}`)

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: !HEADED,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-features=IsolateOrigins,site-per-process'],
    defaultViewport: { width: 1280, height: 900 },
  })
  const page = (await browser.pages())[0]

  // Dialog handler
  page.on('dialog', async (dialog) => { log('Dialog:', dialog.message()); await dialog.accept() })

  // Auto-reinject on navigation
  page.on('framenavigated', async (frame) => {
    if (frame !== page.mainFrame() || !frame.url().includes('wx.qq.com')) return
    log('Page navigated — re-injecting')
    try {
      await page.waitForFunction(() => typeof angular !== 'undefined' && angular.element(document).injector(), { timeout: 15000 })
      await page.evaluate(INJECT_SCRIPT)
      await page.evaluate(() => { if (window.WechatyBro && !window.WechatyBro.vars.initState) return window.WechatyBro.init(); return { code: 304 } })
      await page.evaluate(() => { if (window.WechatyBro) window.WechatyBro._loadLastMsgTime() })
    } catch (e) { log('Re-inject failed:', e.message) }
  })

  // Load cookies
  if (!FIRST_LOGIN && fs.existsSync(COOKIE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'))
      const arr = Array.isArray(raw) ? raw : (raw.cookies || [])
      if (arr.length) await page.setCookie(...arr)
    } catch (e) { log('Cookie load:', e.message) }
  }

  await page.goto(WX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => typeof angular !== 'undefined' && angular.element(document).injector(), { timeout: 30000 })
  log('Angular ready')

  // Expose event bridge — events stream to stdout as JSON lines.
  // Message events are also appended to messages.jsonl for external agents to watch.
  let msgFd
  try { msgFd = fs.openSync(MESSAGES_FILE, 'a') } catch {}

  await page.exposeFunction('sendToPuppeteer', (event, data) => {
    if (data && data.voiceBase64 && (event === 'message:voice' || (event === 'message' && data.MsgType === 34))) {
      transcribeVoice(data)
    }
    const line = { event, data, ts: Date.now() }
    write(line)
    // Append message events to JSONL file for external agents
    if ((event === 'message' || event.startsWith('message:')) && msgFd) {
      try { fs.writeSync(msgFd, JSON.stringify(line) + '\n') } catch {}
    }
    // Show QR code: stderr + open image in browser when headless
    if (event === 'scan' && data && data.url) {
      try { qrTerm.generate(data.url, { small: true }) } catch {}
      if (!HEADED && data.url !== lastQrUrl) {
        lastQrUrl = data.url
        const openCmd = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open')
        execSync(`${openCmd} "${data.url}" 2>/dev/null || true`, { shell: true })
      }
    }
  })

  await page.evaluate(INJECT_SCRIPT)
  const initResult = await page.evaluate(() => {
    if (window.WechatyBro && !window.WechatyBro.vars.initState) return window.WechatyBro.init()
    return { code: 304 }
  })
  log('Init:', initResult.code, initResult.message)

  // Login
  const isLoggedIn = await page.evaluate(() => !!(window.MMCgi && window.MMCgi.isLogin))
  if (!isLoggedIn) {
    log('Waiting for QR scan...')
    try { await page.waitForFunction(() => window.WechatyBro && window.WechatyBro.vars.loginState === true, { timeout: LOGIN_TIMEOUT }); log('Login detected') } catch (e) { log('Login timeout') }
  } else { log('Already logged in') }

  try { await page.waitForFunction(() => window.WechatyBro && window.WechatyBro.vars.contactsReady === true, { timeout: 120_000 }); log('Contacts ready') } catch {}
  try { const c = await page.cookies(); fs.writeFileSync(COOKIE_FILE, JSON.stringify(c, null, 2)) } catch {}

  // Emit a "ready" event so the agent knows it can start sending commands
  write({ event: 'ready', data: { loggedIn: isLoggedIn, contactsReady: true } })

  // ── Wire up WebSocket dispatch (now that page is ready) ───────────────
  wsDispatch = async (cmd, args) => {
    if (cmd === 'exit') {
      await browser.close()
      process.exit(0)
    }
    return dispatch(cmd, args, page)
  }

  // ── Stdin reader — JSON commands ──────────────────────────────────────
  const rl = readline.createInterface({ input: process.stdin, terminal: false })

  for await (const line of rl) {
    if (!line.trim()) continue

    let req
    try { req = JSON.parse(line) } catch {
      write({ ok: false, error: 'invalid json', id: null })
      continue
    }

    const { cmd, id } = req

    if (cmd === 'exit') {
      write({ ok: true, id })
      await browser.close()
      process.exit(0)
    }

    try {
      const result = await dispatch(cmd, req, page)
      write({ ok: true, id, data: result })
    } catch (e) {
      write({ ok: false, id, error: e.message || String(e) })
    }
  }

  // stdin closed — clean up
  await browser.close()
  process.exit(0)
}

// ── Send text with @mention conversion (shared helper) ──────────────────
async function sendText(page, to, content) {
  return page.evaluate((to, content) => {
    const WB = window.WechatyBro
    const resolved = WB._resolveUserName(to) || to
    const isRoom = resolved.startsWith('@@')
    content = content.replace(/@(\w[\w@.-]*)/g, (match, id) => {
      const un = WB._resolveUserName(id)
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
  switch (cmd) {
    case 'contacts':
      return page.evaluate(() => window.WechatyBro.contactList().map(c => ({ id: c.id, name: c.name, UserName: c.UserName, isRoomContact: c.isRoomContact, memberCount: c.memberCount })))

    case 'rooms':
      return page.evaluate(() => window.WechatyBro.contactList().filter(c => c.isRoomContact).map(c => ({ id: c.id, name: c.name, UserName: c.UserName, memberCount: c.memberCount })))

    case 'room-members':
      if (!args.id) throw new Error('Missing --id')
      return page.evaluate((rid) => window.WechatyBro.getRoomMembers(rid), args.id)

    case 'get-contact':
      if (!args.id) throw new Error('Missing --id')
      return page.evaluate((cid) => window.WechatyBro.getContact(cid), args.id)

    case 'send':
      if (!args.to) throw new Error('Missing --to')
      if (!args.content) throw new Error('Missing --content')

      // ── Parse content into segments ──────────────────────────────────
      const segs = parseSegments(args.content)
      const renderable = segs.filter(s => s.type === 'marpit' || s.type === 'mermaid')

      if (renderable.length === 0) {
        // Plain text — no blocks to render
        return sendText(page, args.to, args.content)
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
          const outFile = path.join(tmpDir, 'slides.html')
          const fname = marpitN === 1 ? 'slides.html' : `slides-${marpitN}.html`
          try {
            fs.writeFileSync(mdFile, seg.content)
            execSync(`npx @marp-team/marp-cli "${mdFile}" -o "${outFile}"`, { timeout: 30000, stdio: 'pipe' })
            const htmlBuf = fs.readFileSync(outFile)
            await sendFile(page, args.to, htmlBuf, fname)
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
            await sendImage(page, args.to, pngBuf, fname)
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
      if (caption) await sendText(page, args.to, caption)

      return { sent: true, to: args.to, files, caption: caption || undefined }

    case 'send-image':
      if (!args.to) throw new Error('Missing --to')
      if (!args.path) throw new Error('Missing --path (local file path)')
      if (!fs.existsSync(args.path)) throw new Error(`File not found: ${args.path}`)
      await sendImage(page, args.to, fs.readFileSync(args.path), args.filename || path.basename(args.path))
      return { sent: true, to: args.to, file: args.filename || path.basename(args.path) }

    case 'send-file':
      if (!args.to) throw new Error('Missing --to')
      if (!args.path) throw new Error('Missing --path (local file path)')
      if (!args.filename) throw new Error('Missing --filename (shown to recipient)')
      if (!fs.existsSync(args.path)) throw new Error(`File not found: ${args.path}`)
      await sendFile(page, args.to, fs.readFileSync(args.path), args.filename)
      return { sent: true, to: args.to, file: args.filename }

    case 'send-voice':
      if (!args.to) throw new Error('Missing --to')
      if (!args.path) throw new Error('Missing --path (local audio file)')
      if (!fs.existsSync(args.path)) throw new Error(`File not found: ${args.path}`)
      log('Transcribing:', args.path)
      const text = transcribeFile(args.path)
      if (!text) throw new Error('Transcription returned empty result')
      log('Transcribed:', text.slice(0, 80))
      return page.evaluate((to, content) => {
        const ok = window.WechatyBro.send(to, content, true)
        return { sent: ok, to, transcription: content }
      }, args.to, text)

    case 'status':
      return page.evaluate(() => ({
        loggedIn: !!window.WechatyBro.vars.loginState,
        contactsReady: !!window.WechatyBro.vars.contactsReady,
        lastMsgTime: window.WechatyBro._lastMsgTime || 0,
        initState: !!window.WechatyBro.vars.initState,
      }))

    case 'supported-emojis':
      return page.evaluate(() => window.WechatyBro.getSupportedEmojis())

    default:
      throw new Error(`Unknown command: ${cmd}`)
  }
}

// Only auto-run when executed directly (not when required for tests)
if (require.main === module) {
  main().catch(e => {
    log('Fatal:', e.message)
    process.exit(1)
  })
}

// Exported for unit tests
module.exports = { parseSegments }
