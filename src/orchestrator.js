/**
 * orchestrator.js — `wechat-bro orchestrator`
 *
 * A file-driven agent dispatcher. Connects to the wechat-bro daemon as a
 * plain WebSocket client (auto-starting one as a child process when none is
 * running), watches message events for the contacts declared in `*.md`
 * frontmatter, and dispatches each conversation to a harness CLI (pi by
 * default) as a resumable headless task rooted in the contact's own folder.
 * The account user talks to the orchestrator via `filehelper`.
 *
 * Agent md frontmatter (YAML-lite) configures each task:
 *   ---
 *   name: wechat-alice        # required, unique
 *   description: ...          # free text
 *   contacts: [Alice]         # dedicated routing — exact contact names
 *   contacts-assistant: [Bob] # dedicated routing in ASSISTANT mode
 *   type: contact             # contact | room | orchestrator (fallback class)
 *   harness: pi               # named harness (pi default; claude/codex/copilot
 *                             # built in) or a shell command template with
 *                             # {var} placeholders — see below
 *   session-id: wechat-alice  # default: wechat-<sanitized contact>
 *   session-dir: ~/.wechat-bro/contacts/Alice/session
 *   cwd: ~/.wechat-bro/contacts/Alice
 *   timeout: 900              # seconds, default 900
 *   notify: true              # concise note → filehelper at dispatch, but
 *                             # ONLY when the message needs a response
 *   ---
 *   <body> = agent system prompt; symlinked as AGENTS.md into the task cwd.
 *
 * Dispatch avoids long argv (EDR kills >1KB command lines): the message is
 * written to a task file referenced as `@<file>` (pi) / `{task}` (template),
 * and the agent body is a symlink, never an argument.
 *
 * Harness templates: `harness:` (and the --harness CLI flag) is either the
 * bare NAME of a built-in template (`pi` `claude` `codex` `copilot` — each
 * encodes that CLI's own headless/resume/approval flags) or a custom shell
 * command run via /bin/sh -c. `{var}` placeholders are substituted with
 * shell-quoted values, so each harness declares its own session-history and
 * task-input conventions instead of the orchestrator hardcoding them:
 *   {task}         task file name relative to the task cwd (pi: `@{task}`)
 *   {task-path}    absolute path of the task file
 *   {session-dir}  session history directory (absolute)
 *   {session-id}   session id (harness resumes <session-dir>/<session-id>)
 *   {cwd}          task working directory (absolute)
 *   {contact}      contact/chat this dispatch serves
 *   {name}         agent name
 *   {timeout}      dispatch timeout in seconds (frontmatter `timeout:`)
 * `harness: pi` (or unset) picks the built-in `npx pi` command line (thinking
 * off, no skills). There are no provider/model/thinking/skills frontmatter keys —
 * a harness wanting different flags writes its own template. `${VAR}` shell
 * forms are NOT substituted; unknown placeholders are left verbatim.
 *
 * Agent mds load from ONE user dir, `~/.wechat-bro/agents/` (plain `.md`,
 * legacy `.agent.md` accepted; README/hidden ignored), with the skill's own
 * bundled `agents/` as fallback defaults. They reload per incoming message,
 * so edits apply immediately.
 */

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const WebSocket = require('ws')
const { writePid, clearPid, probeDaemon } = require('./lifecycle')

const DATA_DIR = process.env.WECHAT_BRO_DATA_DIR || path.join(os.homedir(), '.wechat-bro')
// The ONE user agents dir. The skill's bundled agents/ (inside the installed
// package) provides fallback defaults for anything not overridden here.
const AGENTS_DIR = path.join(DATA_DIR, 'agents')
const PKG_AGENTS_DIR = path.join(__dirname, '..', 'skills', 'wechat-bro', 'agents')
const CLI = path.join(__dirname, 'cli.js')

function log(...args) {
  process.stderr.write(`[orchestrator] ${args.join(' ')}\n`)
}

function expand(p) {
  if (!p) return p
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p)
}

function sanitizeFsName(name) {
  const s = String(name).replace(/[/\\:*?"<>|\s]+/g, '_').replace(/\.{2,}/g, '.').replace(/^\.+/, '')
  return (s === '' || s === '.' || s === '..') ? '_' : s.slice(0, 80)
}

// ── Frontmatter ───────────────────────────────────────────────────────────

/** YAML-lite frontmatter: `key: value`, `key: [a, b]`, `#` comments. */
function parseFrontmatter(text) {
  const data = {}
  let body = text
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (m) {
    body = text.slice(m[0].length)
    for (let line of m[1].split(/\r?\n/)) {
      line = line.trim()
      if (!line || line.startsWith('#')) continue
      const idx = line.indexOf(':')
      if (idx === -1) continue
      const key = line.slice(0, idx).trim()
      let val = line.slice(idx + 1).trim()
      if (val.startsWith('[') && val.endsWith(']')) {
        val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      } else if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1) // only strip FULLY-quoted values (a trailing quote may be shell syntax)
      }
      if (val !== '') data[key] = val
    }
  }
  return { data, body }
}

function loadAgentFile(p) {
  const { data, body } = parseFrontmatter(fs.readFileSync(p, 'utf8'))
  if (!data.name) data.name = path.basename(p).replace(/\.agent\.md$|\.md$/, '')
  return { path: p, data, body }
}

function listAgentMds(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md') && !/^(README|\.)/i.test(f))
      .map(f => path.join(dir, f))
  } catch { return [] }
}

/**
 * Load agent mds: `~/.wechat-bro/agents/` (the only user dir) wins by `name`;
 * the skill's bundled agents/ provides the defaults. No seeding: in a user
 * env the skill is installed, so defaults always exist without touching
 * ~/.wechat-bro.
 */
function loadAgents() {
  const agents = new Map()
  for (const dir of [PKG_AGENTS_DIR, AGENTS_DIR]) {
    if (!fs.existsSync(dir)) continue
    for (const p of listAgentMds(dir)) {
      const a = loadAgentFile(p)
      agents.set(a.data.name, a)
    }
  }
  return [...agents.values()]
}

/** Watch list = union of `contacts` + `contacts-assistant` across all agent
 *  mds. */
function watchList(agents) {
  const set = new Set()
  for (const a of agents) {
    for (const key of ['contacts', 'contacts-assistant']) {
      const v = a.data[key]
      for (const c of Array.isArray(v) ? v : (v ? [v] : [])) set.add(c)
    }
  }
  return set
}

function contactList(d, key = 'contacts') {
  const v = d[key]
  return Array.isArray(v) ? v : (v ? [v] : [])
}

/** Route a contact name to its agent AND its configured mode:
 *  `contacts-assistant` matches win (assistant-managed contact), then
 *  dedicated `contacts` (maintainer default), then the unrestricted agent of
 *  the matching `type` (maintainer default). Returns {agent, assistant} or
 *  null. filehelper → orchestrator is handled by the caller. */
function routeAgent(agents, name, isRoom) {
  for (const a of agents) {
    if (contactList(a.data, 'contacts-assistant').includes(name)) return { agent: a, assistant: true }
  }
  for (const a of agents) {
    if (contactList(a.data).includes(name)) return { agent: a, assistant: false }
  }
  const type = isRoom ? 'room' : 'contact'
  for (const a of agents) {
    if (a.data.type === type
      && contactList(a.data).length === 0
      && contactList(a.data, 'contacts-assistant').length === 0) {
      return { agent: a, assistant: false }
    }
  }
  return null
}

function orchestratorAgent(agents) {
  return agents.find(a => a.data.type === 'orchestrator') || null
}

// ── Task rendering & dispatch ─────────────────────────────────────────────

/**
 * Render the task file. `opts` decides the persona:
 *   - `assistant: true`            → ASSISTANT MODE (AI open, 🤖 prefix).
 *     filehelper is always assistant; contacts get it via the `?!` ping or
 *     `contacts-assistant` config.
 *   - `recordOnly: true`           → assistant-MANAGED contact, but this
 *     message has NO `?!` ping: do NOT reply — record for context and end
 *     with {"status":"ignored"}.
 *   - otherwise                    → maintainer mode (AI hidden).
 */
function renderTask(msg, extra, opts = {}) {
  if (typeof opts === 'boolean') opts = { assistant: opts }
  const { assistant = false, recordOnly = false } = opts
  const lines = [
    `# WeChat task — ${new Date().toISOString()}`,
    '',
    `Message from **${msg.from}**${msg.to && msg.to !== msg.from ? ` (chat: ${msg.to})` : ''}${msg.sender ? ` — sender: ${msg.sender}` : ''}.`,
    '',
    '```json',
    JSON.stringify(msg, null, 2),
    '```',
  ]
  if (assistant && !recordOnly) {
    lines.push('',
      `**ASSISTANT MODE** — this message is addressed to the AI assistant${msg.from === 'me' ? ' by the account owner' : ''}. Drop the maintainer persona: answer directly, honestly and helpfully as a capable AI assistant (you MAY say you are an assistant bot). **Your reply MUST start with the bot emoji 🤖**.`,
      '')
  }
  if (recordOnly) {
    const why = msg.from === 'me'
      ? 'this message was sent by the account owner (`me`) in a chat handled by the maintainer persona'
      : 'this contact is assistant-managed, but this message did NOT ping the assistant (no `?!`)'
    lines.push('',
      `**CONTEXT-ONLY MESSAGE** — ${why}. Do NOT reply to it. Silently absorb it as context (update memory.md if it carries something durable) and end with \`{"status":"ignored"}\`.`,
      '')
  }
  if (assistant && !recordOnly && msg.from !== 'me') {
    lines.push('',
      'Assistant-ping protocol: reply ONLY to the `?!…` message itself (openly, 🤖 prefix). Every other message in this chat is CONTEXT ONLY — never reply to it as the AI; the maintainer persona handles those (or stays silent).')
  }
  if (extra) { lines.push('', extra) }
  lines.push('',
    'Follow your instructions above. Send your reply (if any) to WeChat via wechat-bro BEFORE you finish, then end your final output with exactly ONE JSON result line (the orchestrator parses it):',
    '- `{"status":"addressed"}` — handled (replied, or deliberately silent per rules)',
    '- `{"status":"ignored"}` — no reply was needed',
    '- `{"status":"escalated","question":"<what the owner must decide, with context>"}` — needs the account owner\'s decision',
    '')
  return lines.join('\n')
}

/** Point <cwd>/AGENTS.md at the agent md (refresh when target changed). */
function ensureAgentsMd(cwd, agentPath) {
  const dst = path.join(cwd, 'AGENTS.md')
  try {
    if (fs.readlinkSync(dst) === agentPath) return
  } catch { /* not a symlink */ }
  try { fs.unlinkSync(dst) } catch {}
  try { fs.symlinkSync(agentPath, dst) } catch { fs.copyFileSync(agentPath, dst) }
}

/** POSIX-quote a value for safe interpolation into a shell command line. */
function shellQuote(s) {
  s = String(s)
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'` + s.replace(/'/g, `'\\''`) + `'`
}

/** Built-in harness templates, one per supported CLI, expressed as shell
 *  command lines: each CLI's own headless/approval/session flags are baked
 *  in — provider/model/thinking are NOT frontmatter keys; a harness wanting
 *  different flags writes its own template. Everything dispatch fills per
 *  message stays a {var} placeholder. The `||` fallbacks cover a harness's
 *  "no session yet" error on resume (first message of a contact).
 *  - pi:      --session-id creates the session if missing; task via @file.
 *             `npx` so a global pi install is never required.
 *  - claude:  sessions are per-cwd (contact root), so --continue resumes this
 *             contact's last conversation; prompt via stdin.
 *  - codex:   resume --last is scoped to the cwd; `exec -` reads the prompt
 *             from stdin; --skip-git-repo-check because contact roots are not
 *             repos; full access so the agent can run wechat-bro send commands.
 *  - copilot: --continue resumes the last local session (per cwd); "$(cat …)"
 *             passes the prompt (copilot -p takes no stdin); -s keeps stdout
 *             to the agent's reply so the JSON result line parses cleanly. */
const HARNESS_TEMPLATES = {
  pi: 'npx pi -p --session-dir {session-dir} --session-id {session-id} --thinking off --no-skills @{task}',
  claude: 'claude -p --dangerously-skip-permissions --continue < {task} 2>/dev/null || claude -p --dangerously-skip-permissions < {task}',
  codex: 'codex exec resume --last --skip-git-repo-check --sandbox danger-full-access "$(cat {task-path})" 2>/dev/null || codex exec --skip-git-repo-check --sandbox danger-full-access - < {task-path}',
  copilot: 'copilot --continue -p "$(cat {task})" --allow-all -s 2>/dev/null || copilot -p "$(cat {task})" --allow-all -s',
}

/** A bare harness NAME picks its built-in template; anything else (a custom
 *  template, or unset → pi) passes through. */
function defaultHarness(name = 'pi') {
  return HARNESS_TEMPLATES[name] || name
}

/** Values for the `{var}` placeholders of a harness template. */
function harnessVars(d, { task, taskPath, contact, timeoutS }) {
  return {
    task, 'task-path': taskPath,
    'session-dir': d.sessionDir, 'session-id': d.sessionId,
    cwd: d.cwd, contact, name: d.name,
    timeout: String(timeoutS),
  }
}

/** Substitute `{var}` placeholders with shell-quoted values. Unknown keys and
 *  `${VAR}` shell forms are left untouched. */
function renderHarness(template, vars) {
  return String(template).replace(/(?<!\$)\{([\w-]+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? shellQuote(vars[key]) : whole)
}

/**
 * The task contract: the harness's final stdout must end with a JSON result
 * line `{"status":"addressed"|"ignored"|"escalated","question":...}`.
 * Scan from the last line backwards for the most recent parseable JSON object
 * with a known `status`; anything else (no JSON, harness noise, timeout)
 * degrades to `addressed` so the loop never stalls on a chatty agent.
 */
const RESULT_STATUS = new Set(['addressed', 'ignored', 'escalated'])
function parseTaskResult(stdout) {
  const lines = String(stdout || '').trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      const obj = JSON.parse(line)
      if (obj && RESULT_STATUS.has(obj.status)) return obj
    } catch { /* not JSON — keep scanning */ }
  }
  return null
}

class ContactQueue { // serializes dispatches per contact
  constructor() { this.tail = Promise.resolve() }
  run(fn) {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => {})
    return next
  }
}

function makeDispatcher({ wsSend, onEscalation }) {
  const queues = new Map()

  return function dispatch(agent, msg, extra, opts, contactName) {
    if (typeof opts === 'boolean') opts = { assistant: opts }
    const d = agent.data
    const isOrch = d.type === 'orchestrator'
    const name = isOrch ? d.name : (contactName || msg.from || d.name)
    if (!queues.has(name)) queues.set(name, new ContactQueue())
    const queue = queues.get(name)

    // Orchestrator agent has FIXED paths (not configurable): it works in the
    // data dir with one dedicated session. Contact agents derive paths from
    // frontmatter (re-resolved per dispatch so edits apply next message).
    const base = isOrch
      ? DATA_DIR
      : expand(d.cwd || path.join(DATA_DIR, 'contacts', sanitizeFsName(name)))
    d.sessionDir = isOrch
      ? path.join(DATA_DIR, 'session')
      : expand(d['session-dir'] || path.join(base, 'session'))
    d.sessionId = isOrch
      ? 'wechat-orchestrator'
      : (d['session-id'] || `wechat-${sanitizeFsName(name)}`)
    d.cwd = base
    fs.mkdirSync(base, { recursive: true })
    fs.mkdirSync(d.sessionDir, { recursive: true })
    ensureAgentsMd(base, agent.path)

    const taskFile = path.join(base, `.task-${Date.now()}.md`)
    fs.writeFileSync(taskFile, renderTask(msg, extra, opts))

    // Bare harness name → its built-in template; custom template or unset
    // (→ pi) passes through. All templates run via /bin/sh with {var} subs.
    const tpl = defaultHarness(d.harness)
    const timeoutS = parseInt(d.timeout, 10) || 900
    const timeoutMs = timeoutS * 1000
    const taskRef = path.basename(taskFile)
    const cmdline = renderHarness(tpl, harnessVars(d, {
      task: taskRef, taskPath: taskFile, contact: name, timeoutS,
    }))

    const label = `${d.name} ← ${name}`
    log('dispatch', label, d.sessionId)
    const startedAt = Date.now()

    // notify:true → a concise note fires NOW, when the message is received —
    // but only when it NEEDS A RESPONSE: a real incoming message the persona
    // handles or an assistant ping. Never for context-only recordings (no
    // reply will happen) nor for the owner's own messages (they sent them).
    if (d.notify && !isOrch && msg.from !== 'me' && !opts.recordOnly) {
      const snippet = String(msg.Content || msg.content || '').split('\n')[0].trim().slice(0, 100)
      wsSend({ cmd: 'send-text', to: 'filehelper', content: `📨 ${name}: ${snippet}` })
    }

    const spawnTask = () => new Promise((resolve) => {
      let stdout = ''
      const child = spawn('/bin/sh', ['-c', cmdline], { cwd: base, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => { log('timeout', label); child.kill('SIGKILL') }, timeoutMs)
      child.stdout.on('data', c => { stdout += c })
      child.stderr.on('data', c => { stdout += c })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout })
      })
    })

    return queue.run(async () => {
      try {
        const { code, stdout } = await spawnTask()
        log(`done (${Date.now() - startedAt}ms, exit ${code})`, label)
        const tail = stdout.trim().split('\n').slice(-8).join('\n')
        if (code !== 0) {
          await wsSend({ cmd: 'send-text', to: 'filehelper', content: `⚠️ ${d.name} task failed (exit ${code}) for ${name}:\n${tail.slice(0, 800)}` })
        } else {
          const result = parseTaskResult(stdout)
          log('result', label, JSON.stringify(result || { status: 'addressed (no JSON)' }))
          if (result && result.status === 'escalated' && !isOrch) {
            onEscalation(name, String(result.question || '(no question given)'))
          }
        }
        return { code, stdout }
      } finally {
        try { fs.unlinkSync(taskFile) } catch {}
      }
    })
  }
}

// ── WS client loop ────────────────────────────────────────────────────────

function sendCommand(ws, req, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = `orch-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const onMsg = (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.id === id) {
        ws.off('message', onMsg)
        clearTimeout(t)
        msg.ok ? resolve(msg.data) : reject(new Error(msg.error || 'command failed'))
      }
    }
    const t = setTimeout(() => { ws.off('message', onMsg); reject(new Error('timeout')) }, timeoutMs)
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ ...req, id }))
  })
}

async function isRoomContact(ws, cache, name) {
  if (cache.has(name)) return cache.get(name)
  let room = false
  try {
    const data = await sendCommand(ws, { cmd: 'get-contact', id: name })
    room = !!(data && data.isRoomContact)
  } catch { /* unknown → treat as individual */ }
  cache.set(name, room)
  return room
}

/** One WebSocket connection. `onEvent` receives broadcast events (no id);
 *  `onClose` fires once when the socket drops. */
function connect(port, { onEvent, onClose }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    let open = false
    const t = setTimeout(() => { ws.terminate(); reject(new Error(`no daemon on port ${port}`)) }, 3000)
    ws.on('open', () => {
      open = true
      clearTimeout(t)
      ws.on('message', (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        if (msg.id || !msg.event) return // command responses are not events
        try { onEvent(msg) } catch (e) { log('event handler error:', e.message) }
      })
      ws.on('close', () => onClose())
      ws.on('error', () => {})
      resolve(ws)
    })
    ws.on('error', (e) => {
      if (!open) { clearTimeout(t); reject(e) }
    })
  })
}

// ── Entry point ───────────────────────────────────────────────────────────

function flagValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null
}

async function runOrchestrator({ port = 9231 } = {}) {
  const argv = process.argv.slice(2)
  const cliHarness = flagValue(argv, '--harness')
  const daemonFlag = argv.includes('--daemon')

  let agents = loadAgents()
  for (const a of agents) { if (cliHarness) a.data.harness = cliHarness }

  const orchestrator = orchestratorAgent(agents)
  if (!orchestrator) {
    log('WARNING: no agent md with `type: orchestrator` — filehelper messages will be ignored')
  }
  const watch = watchList(agents)
  watch.delete('filehelper')
  log(`loaded ${agents.length} agent md(s) (user: ${AGENTS_DIR}; skill defaults: ${PKG_AGENTS_DIR})`)
  for (const a of agents) log('  -', a.data.name, a.data.type || '', JSON.stringify({ contacts: contactList(a.data), assistant: contactList(a.data, 'contacts-assistant') }))
  log(`watch list: [${[...watch].join(', ') || 'none'}]`)

  let ws = null
  let startedAt = Date.now()
  const roomCache = new Map()
  let dispatch = null
  let closed = false
  // contact -> question, set when a maintainer task returns
  // {"status":"escalated"}; consumed by the owner's next filehelper reply.
  const pendingEscalations = new Map()

  const wsSend = (req) => ws ? sendCommand(ws, req).catch(e => log('send failed:', e.message)) : Promise.resolve()

  // Task returned {"status":"escalated"} → report to the owner in a fixed
  // format and hold the question for routing.
  const onEscalation = (contact, question) => {
    pendingEscalations.set(contact, question)
    log('escalation from', contact)
    wsSend({
      cmd: 'send-text',
      to: 'filehelper',
      content: `🤖❓ 请示 — ${contact}\n${question}\n（回复本条消息，我会转达并记入 TA 的会话）`,
    })
  }

  const onEvent = async (msg) => {
    const ev = msg.event
    if (ev === 'ready' || ev === 'contacts-ready') {
      log('daemon', ev, JSON.stringify(msg.data || {}))
      return
    }
    if (!ev.startsWith('message')) return
    const data = msg.data
    if (!data || typeof data !== 'object' || !data.from) return
    log('event:', ev, `${data.from} → ${data.to}${data.sender ? ` (by ${data.sender})` : ''}`)
    // data.ts is the message CreateTime (unix SECONDS); normalize before the
    // replay check (wrapper msg.ts is ms — prefer data.ts, it's the message's
    // own timestamp).
    const msgTs = data.ts ? (data.ts < 1e12 ? data.ts * 1000 : data.ts) : msg.ts
    if (msgTs && msgTs < startedAt) return log('  dropped: replayed (older than startup)')

    // Account owner's messages: → filehelper is ALWAYS answered in assistant
    // mode (a pending escalation routes the reply into that contact's
    // session). → any other watched chat: assistant-managed contacts get an
    // open assistant reply (assistant mode answers ANYONE, `me` included);
    // maintainer-managed contacts only RECORD the owner's message in their
    // session for context — never replied, `{"status":"ignored"}`.
    if (data.from === 'me') {
      if (data.to !== 'filehelper' && !watch.has(data.to)) return
      agents = loadAgents()
      if (cliHarness) for (const a of agents) a.data.harness = cliHarness
      if (data.to === 'filehelper') {
        if (pendingEscalations.size > 0) {
          const [contact, question] = pendingEscalations.entries().next().value
          pendingEscalations.delete(contact)
          const routed = routeAgent(agents, contact, await isRoomContact(ws, roomCache, contact))
          if (routed) {
            log('escalation reply →', contact)
            const extra = `The account owner is replying to your earlier escalation about: "${question}"\nThe owner's answer: "${String(data.Content || data.content || '')}"\nDeliver the answer to the contact via wechat-bro (their words, natural tone, no bot emoji), and update memory.md/rules.md if the answer settles a standing question. End with the JSON result line as usual.`
            dispatch(routed.agent, data, extra, { assistant: false, recordOnly: false }, contact)
            return
          }
          log('no agent for escalation contact', contact, '— falling back to orchestrator')
        }
        if (orchestratorAgent(agents)) dispatch(orchestratorAgent(agents), data, null, { assistant: true })
        else log('no orchestrator agent — cannot handle filehelper message')
        return
      }
      const routed = routeAgent(agents, data.to, await isRoomContact(ws, roomCache, data.to))
      if (!routed) { log('no agent for', data.to, '— skipping own message'); return }
      const extra = data.type && data.type !== 'text'
        ? 'Non-text message: `content` holds the useful representation (file path for media, URL for emoji, text otherwise).'
        : null
      log(routed.assistant ? 'own message → assistant reply in' : 'own message → context-only into', data.to)
      dispatch(routed.agent, data, extra, routed.assistant
        ? { assistant: true, recordOnly: false }
        : { assistant: false, recordOnly: true }, data.to)
      return
    }
    if (!watch.has(data.from)) return

    // Reload agent mds per message so edits apply immediately.
    agents = loadAgents()
    if (cliHarness) for (const a of agents) a.data.harness = cliHarness
    const routed = routeAgent(agents, data.from, await isRoomContact(ws, roomCache, data.from))
    if (!routed) { log('no agent for', data.from, '— skipping'); return }
    const extra = data.type && data.type !== 'text'
      ? 'Non-text message: `content` holds the useful representation (file path for media, URL for emoji, text otherwise).'
      : null
    // Mode: configured assistant contact → assistant-managed (a `?!` ping
    // gets an open AI reply, anything else is record-only). Everyone else:
    // maintainer mode, with `?!` promoting just that message to assistant.
    const text = String(data.Content || data.content || '')
    const ping = text.includes('?!') || text.includes('？！')
    dispatch(routed.agent, data, extra, {
      assistant: routed.assistant || ping,
      recordOnly: routed.assistant && !ping,
    })
  }

  const start = async () => {
    ws = await connect(port, {
      onEvent,
      onClose: () => {
        if (closed) return
        log(`daemon disconnected — reconnecting in 3s`)
        setTimeout(() => connectLoop(), 3000)
      },
    })
    startedAt = Date.now()
    roomCache.clear()
    if (!dispatch) dispatch = makeDispatcher({ wsSend, onEscalation })
    log(`connected to ws://localhost:${port} — watching`)
  }

  // Daemon lifecycle: adopt a running daemon, or spawn one as OUR child —
  // it then lives and dies with this orchestrator (shutdown kills it), and
  // is (re)spawned automatically whenever nothing answers on the port.
  // `--daemon` forces a fresh child even when the port already answers.
  // WECHAT_BRO_NO_DAEMON_SPAWN=1 disables spawning (unit tests: no Chrome).
  let daemonChild = null
  const noSpawn = process.env.WECHAT_BRO_NO_DAEMON_SPAWN === '1'
  const spawnDaemonChild = () => {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const fd = fs.openSync(path.join(DATA_DIR, 'daemon.log'), 'a')
    const child = spawn(process.execPath, [CLI, '--daemon', '--port', String(port)],
      { stdio: ['ignore', fd, fd], env: process.env })
    fs.closeSync(fd)
    child.on('exit', () => { if (daemonChild === child) daemonChild = null })
    daemonChild = child
    log(`spawned daemon child pid ${child.pid} — logs: ${path.join(DATA_DIR, 'daemon.log')}`)
    return child
  }
  const ensureDaemon = async () => {
    if (daemonChild) return true
    if (await probeDaemon(port)) return true
    if (noSpawn) return false
    spawnDaemonChild()
    for (let i = 0; i < 60; i++) { // wait for its WebSocket (Chrome boot takes a while)
      if (await probeDaemon(port, 1500)) return true
      await new Promise(r => setTimeout(r, 500))
    }
    log(`daemon child not reachable on port ${port} — see ${path.join(DATA_DIR, 'daemon.log')}`)
    return false
  }
  // Connect once, then keep retrying forever — (re)spawning our daemon child
  // whenever nothing is listening.
  const connectLoop = async () => {
    for (let attempt = 0; ; attempt++) {
      try { await start(); return } catch (e) {
        if (attempt === 0) log(`daemon not reachable on port ${port} —`, noSpawn ? 'retrying every 5s' : 'spawning one as our child')
        await ensureDaemon()
        await new Promise(r => setTimeout(r, 5000))
      }
    }
  }

  const shutdown = () => {
    closed = true
    clearPid('orchestrator')
    try { ws && ws.close() } catch {}
    if (daemonChild) { try { daemonChild.kill('SIGTERM') } catch {} }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Tracked from the very start so `wechat-bro down`/`up` find this process
  // even when it was started by a service manager instead of `wechat-bro up`.
  writePid('orchestrator')
  if (daemonFlag) spawnDaemonChild()
  await connectLoop()
  log('running — Ctrl-C to stop')
  setInterval(() => {}, 1 << 30) // keep the event loop alive
}

module.exports = {
  parseFrontmatter, loadAgents, loadAgentFile, watchList, routeAgent,
  orchestratorAgent, renderTask, ensureAgentsMd, sanitizeFsName, contactList,
  parseTaskResult, shellQuote, defaultHarness, HARNESS_TEMPLATES,
  harnessVars, renderHarness, runOrchestrator, flagValue, DATA_DIR, AGENTS_DIR,
}
