#!/usr/bin/env node

/**
 * cli.js — Stdin/stdout JSON-line interface for AI agents.
 *
 * A single long-running process. Reads JSON commands from stdin, writes
 * JSON responses and streaming events to stdout.
 *
 * Usage:
 *   node cli.js                    # Headless
 *   node cli.js --headed           # Show browser
 *   node cli.js --first-login      # Force QR re-login
 *
 * Protocol (JSON lines on stdin/stdout):
 *
 *   ← {"event":"heartbeat","data":"heartbeat@browser","ts":...}
 *   → {"cmd":"contacts","id":"1"}
 *   ← {"ok":true,"id":"1","data":[{...}]}
 *   → {"cmd":"send","to":"filehelper","content":"Hello"}
 *   ← {"ok":true,"data":{"sent":true,"to":"filehelper"}}
 *   → {"cmd":"exit"}
 *   ← {"ok":true}
 *
 * The `id` field is optional — if included in the request, it's echoed
 * in the response so the agent can correlate requests and responses.
 *
 * Commands:
 *   contacts          → [{id, name, UserName, isRoomContact, memberCount}]
 *   rooms             → [{id, name, UserName, memberCount}] (rooms only)
 *   room-members      → [{id, name, UserName, ...}]  (args: --id <roomId>)
 *   get-contact       → {id, name, ...}               (args: --id <contactId>)
 *   send              → {sent: true, to}              (args: --to, --content)
 *                                                     @contactid in content auto-converted to @Name 
 *                                                     (always watermarked)
 *   send-image        → {sent: true, to, file}        (args: --to, --path, [--filename])
 *   send-file         → {sent: true, to, file}        (args: --to, --path, --filename)
 *   send-voice        → {sent, to, transcription}     (args: --to, --path)
 *                                                     transcribes audio via Whisper, sends as text
 *   status            → {loggedIn, contactsReady, lastMsgTime}
 *   supported-emojis  → [string]
 *   exit              → shut down
 */

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')
const readline = require('readline')
const puppeteer = require('puppeteer-core')
const qrTerm = require('qrcode-terminal')
const { transcribeVoice, transcribeFile } = require('./transcribe')
const { sendImage, sendFile } = require('./upload')

const DATA_DIR = path.join(os.homedir(), '.wechat-bro')
const COOKIE_FILE = path.join(DATA_DIR, 'cookies.json')
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.jsonl')

const WX_URL = 'https://wx.qq.com'
const INJECT_SCRIPT = fs.readFileSync(path.join(__dirname, 'wechat-bro.js'), 'utf-8')
const FIRST_LOGIN = process.argv.includes('--first-login')
const HEADED = process.argv.includes('--headed')
const LOGIN_TIMEOUT = 300_000

// ── Chrome detection ──────────────────────────────────────────────────────
function findChrome() {
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
  throw new Error('Chrome not found. Set CHROME_PATH env var.')
}

function toLoginUrl(qrUrl) {
  if (!qrUrl || typeof qrUrl !== 'string') return null
  return qrUrl.replace('/qrcode/', '/l/')
}

let lastQrUrl = null

// ── Write JSON to stdout (with newline) ───────────────────────────────────
function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function log(...args) {
  process.stderr.write(`[cli] ${args.join(' ')}\n`)
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  // Ensure data directory exists
  fs.mkdirSync(DATA_DIR, { recursive: true })

  const chromePath = process.env.CHROME_PATH || findChrome()
  log('Chrome:', chromePath, HEADED ? '(headed)' : '(headless)')

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
      return page.evaluate((to, content) => {
        // Auto-convert @contactid → @Name\u2005 using the room context
        // so the agent can write  @alice check this  and it becomes a real mention.
        const WB = window.WechatyBro
        const resolved = WB._resolveUserName(to) || to
        const isRoom = resolved.startsWith('@@')
        content = content.replace(/@(\w[\w@.-]*)/g, (match, id) => {
          // resolve the mentioned id
          const un = WB._resolveUserName(id)
          if (!un) return match  // not a known contact, leave as-is
          // Check if the target is within the same room (if this is a room msg)
          const mention = isRoom ? WB.at(un, resolved) : WB.at(un)
          return mention || match
        })
        const ok = WB.send(to, content, true)
        return { sent: ok, to }
      }, args.to, args.content)

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

main().catch(e => {
  log('Fatal:', e.message)
  process.exit(1)
})
