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
const { CodexResidentAdapter } = require('./codex-resident')

const DATA_DIR = process.env.WECHAT_BRO_DATA_DIR || path.join(os.homedir(), '.wechat-bro')
// The ONE user agents dir. The skill's bundled agents/ (inside the installed
// package) provides fallback defaults for anything not overridden here.
const AGENTS_DIR = path.join(DATA_DIR, 'agents')
const PKG_AGENTS_DIR = path.join(__dirname, '..', 'skills', 'wechat-bro', 'agents')
const CLI = path.join(__dirname, 'cli.js')

// Scheduled self-wakeup (`next_action.wake`) bounds and durable store. The
// ORCHESTRATOR — never the worker — owns timers, bounds and persistence, so a
// worker only ever *requests* a continuation. Env overrides are for tests and
// unusual deployments.
const num = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)
const WAKE_MIN_SECONDS = num(process.env.WECHAT_BRO_WAKE_MIN_SECONDS, 30)
const WAKE_MAX_SECONDS = num(process.env.WECHAT_BRO_WAKE_MAX_SECONDS, 7 * 24 * 60 * 60)
const WAKE_MAX_OVERDUE_SECONDS = num(process.env.WECHAT_BRO_WAKE_MAX_OVERDUE_SECONDS, 24 * 60 * 60)
const WAKES_FILE = 'pending-wakes.json'

function log(...args) {
  process.stderr.write(`[orchestrator] ${args.join(' ')}\n`)
}

/** Probe whether a wechat-bro daemon answers on this port: the ws-server
 *  broadcasts a `connected` event to every new client as soon as it listens. */
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
 *  mds, EXCLUDING `type: orchestrator` agents: their contact lists are
 *  declarative only (filehelper → orchestrator is caller-handled), so a
 *  stray name there can neither widen the watch list nor hijack routing into
 *  the orchestrator's fixed session. */
function watchList(agents) {
  const set = new Set()
  for (const a of agents) {
    if (a.data.type === 'orchestrator') continue
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

function frontmatterValue(value) {
  return /^[\w.-]+$/.test(String(value)) ? String(value) : `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Update YAML-lite watch lists without touching agent prompt bodies. */
function updateAgentWatchConfig(agent, context, add, mode = 'maintainer') {
  const raw = fs.readFileSync(agent.path, 'utf8')
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/.exec(raw)
  if (!match) throw new Error(`agent has no frontmatter: ${agent.path}`)

  let parsed = parseFrontmatter(raw).data
  const updates = new Map()
  const contactNames = contactList(parsed)
  const assistantNames = contactList(parsed, 'contacts-assistant')
  if (add) {
    const assistantMode = mode === 'assistant'
    const targetKey = assistantMode ? 'contacts-assistant' : 'contacts'
    const otherKey = assistantMode ? 'contacts' : 'contacts-assistant'
    const targetNames = assistantMode ? assistantNames : contactNames
    const otherNames = assistantMode ? contactNames : assistantNames
    if (!targetNames.includes(context)) updates.set(targetKey, [...targetNames, context])
    if (otherNames.includes(context)) updates.set(otherKey, otherNames.filter(name => name !== context))
  } else {
    if (assistantNames.includes(context)) updates.set('contacts-assistant', assistantNames.filter(name => name !== context))
    if (contactNames.includes(context)) updates.set('contacts', contactNames.filter(name => name !== context))
  }
  if (updates.size === 0) return false

  const lines = match[2].split(/\r?\n/)
  for (const [key, values] of updates) {
    const lineIndex = lines.findIndex(line => new RegExp(`^\\s*${key}\\s*:`).test(line))
    const line = values.length ? `${key}: [${values.map(frontmatterValue).join(', ')}]` : null
    if (lineIndex !== -1) {
      if (line) lines[lineIndex] = line
      else lines.splice(lineIndex, 1)
    } else if (line) {
      const insertAt = lines.reduce((at, text, index) => /^#/.test(text.trim()) ? index : at + 1, 0)
      lines.splice(insertAt, 0, line)
    }
  }

  const next = match[1] + lines.join('\n') + match[3] + raw.slice(match[0].length)
  if (next === raw) return false
  const tmp = `${agent.path}.${process.pid}.tmp`
  fs.writeFileSync(tmp, next)
  fs.renameSync(tmp, agent.path)
  agent.data = parseFrontmatter(next).data
  return true
}

/** Persist a context on exactly one routing agent, removing duplicate routes. */
function applyPersistentWatch(agents, context, selectedAgent, add, mode = 'maintainer') {
  let selected = selectedAgent || routeAgent(agents, context, false)?.agent
  if (!selected) throw new Error(`no routable agent for ${context}`)
  if (selected.path.startsWith(PKG_AGENTS_DIR)) {
    // Package defaults are immutable installation assets; persist user watch
    // changes as the same-name override that loadAgents already prefers.
    fs.mkdirSync(AGENTS_DIR, { recursive: true })
    const overridePath = path.join(AGENTS_DIR, `${sanitizeFsName(selected.data.name)}.agent.md`)
    fs.copyFileSync(selected.path, overridePath)
    selected = loadAgentFile(overridePath)
  }
  const currentAgents = selectedAgent
    ? agents.map(agent => agent === selectedAgent ? selected : agent)
    : agents
  for (const agent of currentAgents) {
    if (agent === selected) continue
    updateAgentWatchConfig(agent, context, false, mode)
  }
  updateAgentWatchConfig(selected, context, add, mode)
  return loadAgents()
}

/** Route a contact name to its agent AND its configured mode:
 *  `contacts-assistant` matches win (assistant-managed contact), then
 *  dedicated `contacts` (maintainer default), then the unrestricted agent of
 *  the matching `type` (maintainer default). Returns {agent, assistant} or
 *  null. `type: orchestrator` agents never match — their contact lists are
 *  declarative only; filehelper → orchestrator is handled by the caller. */
function routeAgent(agents, name, isRoom) {
  for (const a of agents) {
    if (a.data.type === 'orchestrator') continue
    if (contactList(a.data, 'contacts-assistant').includes(name)) return { agent: a, assistant: true }
  }
  for (const a of agents) {
    if (a.data.type === 'orchestrator') continue
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
  const { assistant = false, recordOnly = false, superseded = null, wake = null } = opts
  if (wake) return renderWakeTask(wake)
  if (opts.host) {
    const update = !!superseded
    return [
      `# Host ${update ? 'guidance update' : 'discussion'} — ${new Date().toISOString()}`,
      '',
      update ? 'HOST GUIDANCE UPDATE' : `HOST DISCUSSION — open a discussion in **${msg.to}** now.`,
      '',
      ...(update ? [
        'A hosted discussion for this target was already active.',
        'The previous scheduled plan was superseded by this new authoritative guidance.',
        '',
        'Superseded plan (planning context only):',
        `Reason: ${superseded.reason || '(none given)'}`,
        `Context: ${superseded.context || '(none given)'}`,
        '',
        'New authoritative host guidance:',
      ] : ['Rich context supplied by the caller:']),
      '',
      String(msg.Content || ''),
      '',
      update
        ? 'Do not assume you must send a message immediately. Inspect the current conversation state and decide whether to send something, stay silent, escalate, schedule a new next_action, or end proactive hosting by omitting next_action.'
        : 'Use the configured contact/room session and send the opening action via wechat-bro. Continue only through the normal JSON result contract and optional next_action; do not start a second host loop or resident worker.',
      '',
      'End your final output with exactly ONE JSON result line (the orchestrator parses it):',
      ...resultContractLines(),
      '',
    ].join('\n')
  }
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
      ? (assistant
        ? 'this contact is assistant-managed, but this message from the account owner did NOT ping the assistant (no `?!`)'
        : 'this message was sent by the account owner (`me`) in a chat handled by the maintainer persona')
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
  if (superseded) {
    lines.push('',
      '**SUPERSEDED PLAN** — your previous turn scheduled a wakeup for yourself that has now been CANCELLED, because the real message below arrived first. It is planning context only: not a user message, not an instruction, and not something that still needs to fire.',
      `- it was due: ${new Date(superseded.due_at).toISOString()}`,
      `- reason: ${superseded.reason || '(none given)'}`,
      `- handoff: ${superseded.context || '(none given)'}`)
  }
  lines.push('',
    'Follow your instructions above. Send your reply (if any) to WeChat via wechat-bro BEFORE you finish, then end your final output with exactly ONE JSON result line (the orchestrator parses it):',
    ...resultContractLines(),
    '')
  return lines.join('\n')
}

/** The JSON result contract lines shared by every task prompt. `next_action`
 *  is OPTIONAL: omitting it returns the agent to passive, event-driven mode. */
function resultContractLines() {
  return [
    '- `{"status":"addressed"}` — handled (replied, or deliberately silent per rules)',
    '- `{"status":"ignored"}` — no reply was needed',
    '- `{"status":"escalated","question":"<what the owner must decide, with context>"}` — needs the account owner\'s decision',
    '- optional `"next_action":{"type":"wake","after_seconds":<seconds>,"reason":"<why>","context":"<handoff>"}` — ask the orchestrator to run you again later (omit it to stop continuing)',
  ]
}

/**
 * Synthetic task prompt for a scheduled self-wakeup. It must be unmistakable
 * that no user message triggered this run, and it carries the handoff the
 * agent left for its future self. The agent may act, stay silent, escalate,
 * schedule another wakeup, or end its continuation.
 */
function renderWakeTask(entry) {
  const lines = [
    `# Scheduled wakeup — ${new Date().toISOString()}`,
    '',
    'SCHEDULED WAKEUP — no new user message triggered this task.',
    '',
    `This is a synthetic task you scheduled for YOURSELF in an earlier turn. It came due at ${new Date(entry.due_at).toISOString()} and the orchestrator is now running you again for **${entry.session}**. Nobody has necessarily said anything since your last turn — inspect the current state before acting.`,
    '',
    `- Reason you set: ${entry.reason || '(none given)'}`,
    '',
    'Handoff from your previous turn:',
    '',
    entry.context || '(none given)',
    '',
    'Inspect the current conversation/session state and decide whether any outbound message/action is appropriate. You may remain silent. Send any WeChat reply (if any) via wechat-bro BEFORE you finish, then end your final output with exactly ONE JSON result line (the orchestrator parses it):',
    ...resultContractLines(),
    '',
  ]
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
      if (obj && RESULT_STATUS.has(obj.status)) return normalizeResult(obj)
    } catch { /* not JSON — keep scanning */ }
  }
  return null
}

/**
 * Backward-compatible result normalization. The only added key is the
 * OPTIONAL `next_action`; when it is present but invalid the raw value is
 * replaced by `next_action: null` plus `next_action_error`, so an invalid
 * request can never silently create a timer. A result without `next_action`
 * is returned untouched.
 */
function normalizeResult(obj) {
  if (!Object.prototype.hasOwnProperty.call(obj, 'next_action')) return obj
  const { action, error } = validateNextAction(obj.next_action)
  if (error) return { ...obj, next_action: null, next_action_error: error }
  if (!action) { const c = { ...obj }; delete c.next_action; return c }
  return { ...obj, next_action: action }
}

/** Validate a worker's optional `next_action`. Returns `{action, error}`:
 *  `action` is the normalized request, `error` a human-readable rejection.
 *  Shape only — delay BOUNDS are clamped by the scheduler, not here. */
function validateNextAction(raw) {
  if (raw === undefined || raw === null) return { action: null, error: null }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { action: null, error: 'next_action must be an object' }
  if (raw.type !== 'wake') return { action: null, error: `next_action.type ${JSON.stringify(raw.type)} is not supported (only "wake")` }
  const secs = Number(raw.after_seconds)
  if (!Number.isFinite(secs) || secs <= 0) return { action: null, error: 'next_action.after_seconds must be a positive number' }
  return { action: {
    type: 'wake',
    after_seconds: secs,
    reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
    context: typeof raw.context === 'string' ? raw.context : '',
  }, error: null }
}

/** Clamp a requested delay into configured bounds. Never trusts the worker. */
function clampDelay(seconds, { minSeconds = WAKE_MIN_SECONDS, maxSeconds = WAKE_MAX_SECONDS } = {}) {
  if (seconds < minSeconds) return { seconds: minSeconds, clamped: `clamped up to the ${minSeconds}s minimum` }
  if (seconds > maxSeconds) return { seconds: maxSeconds, clamped: `clamped down to the ${maxSeconds}s maximum` }
  return { seconds, clamped: null }
}

function wakeFile(dir) { return path.join(dir, WAKES_FILE) }

/**
 * Durable one-pending-wake-per-session store + timer owner.
 *
 * Each entry carries an opaque `id` and a monotonic `version`, so a timer
 * callback that races a replacement/cancellation is detected and ignored.
 * The pending set is persisted to `<DATA_DIR>/pending-wakes.json` on every
 * mutation (atomic tmp+rename), which is what makes restart recovery and
 * duplicate-fire prevention possible.
 */
class WakeScheduler {
  constructor({ dir, dispatchWake, minSeconds = WAKE_MIN_SECONDS, maxSeconds = WAKE_MAX_SECONDS,
                maxOverdueSeconds = WAKE_MAX_OVERDUE_SECONDS, now = () => Date.now() } = {}) {
    this.dir = dir
    this.file = dir ? wakeFile(dir) : null
    this.dispatchWake = dispatchWake || (() => {})
    this.minSeconds = minSeconds
    this.maxSeconds = maxSeconds
    this.maxOverdueSeconds = maxOverdueSeconds
    this.now = now
    this.wakes = new Map()   // session key → entry
    this.timers = new Map()  // entry id → Timeout
    this.versions = new Map() // session key → last version issued in this process
    this._seq = 0
    this._load()
  }

  _load() {
    if (!this.file) return
    let raw = null
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch (e) {
      if (e.code !== 'ENOENT') log('pending-wakes: unreadable, starting empty —', e.message)
    }
    for (const [key, e] of Object.entries((raw && raw.wakes) || {})) {
      if (!e || typeof e !== 'object' || !Number.isFinite(Number(e.due_at))) continue
      this.wakes.set(key, e)
      this.versions.set(key, Math.max(this.versions.get(key) || 0, Number(e.version) || 0))
      this._seq = Math.max(this._seq, Number(e.version) || 0)
    }
  }

  _persist() {
    if (!this.file) return
    fs.mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, wakes: Object.fromEntries(this.wakes) }, null, 2))
    fs.renameSync(tmp, this.file)
  }

  _newId(key) {
    this._seq += 1
    return `${sanitizeFsName(key)}-${Date.now().toString(36)}-${this._seq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  }

  list() { return [...this.wakes.values()].map(e => ({ ...e })) }
  get(key) { const e = this.wakes.get(key); return e ? { ...e } : null }

  /** Replace (or create) the single pending wake for `key`. */
  schedule(key, action, agentName, identity = {}) {
    const { action: norm, error } = validateNextAction(action)
    if (!norm) { log(`next_action rejected for ${key}: ${error} — not scheduling`); return { entry: null, error } }
    const { seconds, clamped } = clampDelay(norm.after_seconds, this)
    if (clamped) log(`next_action for ${key}: after_seconds=${norm.after_seconds}s ${clamped}`)
    const now = this.now()
    const prev = this.wakes.get(key)
    const version = (this.versions.get(key) || 0) + 1
    this.versions.set(key, version)
    const entry = {
      id: this._newId(key),
      version,
      session: key,
      agent: agentName || null,
      due_at: now + Math.round(seconds * 1000),
      after_seconds: seconds,
      reason: norm.reason,
      context: norm.context,
      created_at: prev && prev.created_at ? prev.created_at : now,
      updated_at: now,
    }
    if (prev) this._cancel(prev.id) // drop the replaced schedule's timer
    this._arm(entry)
    this.wakes.set(key, entry)
    this._persist()
    log(`wake scheduled for ${key} in ${seconds}s (id ${entry.id} v${entry.version})${entry.reason ? ` — ${entry.reason}` : ''}`)
    return { entry: { ...entry }, error: null }
  }

  /** Remove + cancel a pending wake (returns the cancelled entry, or null). */
  take(key) {
    const entry = this.wakes.get(key)
    if (!entry) return null
    this._cancel(entry.id)
    this.wakes.delete(key)
    this._persist()
    return { ...entry }
  }

  /** Claim exactly the due entry immediately before its worker is spawned. */
  claim(key, id, version) {
    const entry = this.wakes.get(key)
    if (!entry || entry.id !== id || Number(entry.version) !== Number(version)) {
      log(`stale queued wake for ${key} skipped (id ${id} v${version})`)
      return null
    }
    this._cancel(entry.id)
    this.wakes.delete(key)
    this._persist()
    return { ...entry }
  }

  clear(key) {
    const entry = this.take(key)
    if (entry) log(`wake cleared for ${key} (id ${entry.id})`)
    return entry
  }

  /** (Re)arm timers for every persisted wake. Idempotent; called once at
   *  process start. Future wakes get their remaining delay; overdue wakes
   *  inside the grace window fire once promptly; wakes stale beyond the grace
   *  window are dropped instead of replayed. */
  start() {
    this.stop()
    const now = this.now()
    for (const entry of [...this.wakes.values()]) {
      const overdueMs = now - Number(entry.due_at)
      if (overdueMs > this.maxOverdueSeconds * 1000) {
        log(`wake ${entry.id} for ${entry.session} is ${Math.round(overdueMs / 1000)}s overdue (> ${this.maxOverdueSeconds}s grace) — dropped`)
        this.wakes.delete(entry.session)
        this._persist()
        continue
      }
      if (overdueMs > 0) log(`wake ${entry.id} for ${entry.session} overdue by ${Math.round(overdueMs / 1000)}s — firing once now`)
      else log(`wake ${entry.id} restored for ${entry.session} in ${Math.round((entry.due_at - now) / 1000)}s`)
      this._arm(entry)
    }
  }

  stop() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear() }

  /** Re-arm a consumed entry (e.g. the target cannot be reached right now). */
  reschedule(entry, delayMs) {
    const current = this.wakes.get(entry.session)
    if (!current || current.id !== entry.id || Number(current.version) !== Number(entry.version)) {
      log(`wake reschedule for ${entry.session} skipped: entry was superseded`)
      return null
    }
    const now = this.now()
    const version = Math.max(this.versions.get(entry.session) || 0, Number(entry.version) || 0) + 1
    this.versions.set(entry.session, version)
    const next = {
      ...entry,
      id: this._newId(entry.session),
      version,
      due_at: now + Math.max(0, delayMs),
      updated_at: now,
    }
    this._arm(next)
    this.wakes.set(next.session, next)
    this._persist()
    return { ...next }
  }

  _arm(entry) {
    this._cancel(entry.id)
    const MAX_TIMER = 2147483647
    const delay = Math.max(0, Number(entry.due_at) - this.now())
    const timer = setTimeout(() => {
      if (delay >= MAX_TIMER) this._arm(entry) // longer than setTimeout can hold
      else this._fire(entry.session, entry.id, entry.version)
    }, Math.min(delay, MAX_TIMER))
    if (timer.unref) timer.unref()
    this.timers.set(entry.id, timer)
  }

  _cancel(id) {
    const t = this.timers.get(id)
    if (t) { clearTimeout(t); this.timers.delete(id) }
  }

  _fire(session, id, version) {
    this.timers.delete(id)
    const entry = this.wakes.get(session)
    if (!entry || entry.id !== id || Number(entry.version) !== Number(version)) {
      log(`stale wake callback for ${session} ignored (id ${id} v${version})`)
      return
    }
    // Keep the durable entry until the queued worker reaches its spawn point.
    // A real message can therefore supersede a due-but-not-yet-started wake.
    log(`wake due for ${session} (id ${entry.id} v${entry.version})${entry.reason ? ` — ${entry.reason}` : ''}`)
    try {
      Promise.resolve(this.dispatchWake({ ...entry })).catch(e => log('wake dispatch failed:', e.message))
    } catch (e) { log('wake dispatch failed:', e.message) }
  }
}

/**
 * One owner for watch-command semantics. Persistent agent files define what
 * survives a restart; runtimeWatches and paused define immediate routing.
 */
class WatchControlManager {
  constructor({ agents, port = null, applyWatch = applyPersistentWatch } = {}) {
    this.agents = agents
    this.port = port
    this.applyWatch = applyWatch
    this.configuredWatches = watchList(agents)
    this.configuredWatches.delete('filehelper')
    this.runtimeWatches = new Set(this.configuredWatches)
    this.paused = new Set()
    this.resident = new Set()
    this.hooks = {}
    this.startedAt = Date.now()
  }

  refreshConfigured(agents) {
    this.agents = agents
    this.configuredWatches = watchList(agents)
    this.configuredWatches.delete('filehelper')
  }

  setHooks(hooks) { this.hooks = hooks || {}; return this }

  async handle(action, context, { isRoom = false, agentName = null, mode = 'maintainer', state = null } = {}) {
    if (!context || context === 'filehelper') throw new Error('context is required (filehelper is always managed by the orchestrator)')
    if (!['watch', 'unwatch', 'pause', 'resident'].includes(action)) throw new Error(`unknown watch action: ${action}`)
    if (action === 'watch' && !['maintainer', 'assistant'].includes(mode)) throw new Error('mode must be maintainer or assistant')

    if (action === 'pause') {
      if (!this.runtimeWatches.has(context)) throw new Error(`${context} is not being watched`)
      if (!['on', 'off'].includes(state)) throw new Error('pause requires on or off')
      const changed = state === 'on' ? !this.paused.has(context) : this.paused.delete(context)
      if (state === 'on') {
        this.paused.add(context)
        await this.hooks.onPause?.(context)
      }
      return { action, context, changed, state: state === 'on' ? 'paused' : (this.runtimeWatches.has(context) ? 'watching' : 'unwatched') }
    }
    if (action === 'resident') {
      if (!this.runtimeWatches.has(context)) throw new Error(`${context} is not being watched`)
      if (!['on', 'off'].includes(state)) throw new Error('resident requires on or off')
      const routed = routeAgent(this.agents, context, isRoom)
      if (!routed) throw new Error(`no routable agent for ${context}`)
      if (state === 'on' && routed.agent.data.harness !== 'codex') throw new Error('resident mode requires the codex harness')
      const changed = state === 'on' ? !this.resident.has(context) : this.resident.delete(context)
      if (state === 'on') this.resident.add(context)
      else await this.hooks.onResidentOff?.(context)
      return { action, context, changed, state: state === 'on' ? 'resident' : 'watching' }
    }

    let routed = routeAgent(this.agents, context, isRoom)
    if (action === 'watch' && agentName) {
      const selected = this.agents.find(agent => agent.data.name === agentName && agent.data.type !== 'orchestrator')
      if (!selected) throw new Error(`agent not found or not routable: ${agentName}`)
      routed = { agent: selected, assistant: mode === 'assistant' }
    }
    if (!routed) throw new Error(`no routable agent for ${context}`)
    const wasConfigured = this.configuredWatches.has(context)
    const wasRuntime = this.runtimeWatches.has(context) || this.paused.has(context)
    this.agents = this.applyWatch(this.agents, context, routed.agent, action === 'watch', mode)
    this.refreshConfigured(this.agents)
    if (action === 'watch') {
      this.runtimeWatches.add(context)
      this.paused.delete(context)
    } else {
      this.runtimeWatches.delete(context)
      this.paused.delete(context)
      this.resident.delete(context)
      await this.hooks.onUnwatch?.(context)
    }
    return {
      action,
      context,
      changed: action === 'watch' ? !(wasConfigured && wasRuntime) : (wasConfigured || wasRuntime),
      state: action === 'watch' ? 'watching' : 'unwatched',
      agent: routed.agent.data.name,
      mode: action === 'watch' ? mode : (routed.assistant ? 'assistant' : 'maintainer'),
    }
  }

  isWatched(context) { return this.runtimeWatches.has(context) }
  isPaused(context) { return this.paused.has(context) }
  isResident(context) { return this.resident.has(context) }
  canDispatch(context, phase = 'start') {
    if (!this.isWatched(context) || this.isPaused(context)) return false
    return phase !== 'continuation' || this.isWatched(context)
  }
  clearRuntime(context) {
    this.runtimeWatches.delete(context)
    this.paused.delete(context)
  }

  contextStates() {
    return [...new Set([...this.configuredWatches, ...this.runtimeWatches, ...this.paused])]
      .sort().map(context => {
        const configured = this.configuredWatches.has(context)
        const watching = this.runtimeWatches.has(context)
        const paused = this.paused.has(context)
        const resident = this.resident.has(context)
        return {
          context,
          configured,
          watching,
          paused,
          resident,
          state: paused ? 'paused' : (resident ? 'resident' : (watching ? 'watching' : 'unwatched')),
          mismatch: configured !== watching,
        }
      })
  }

  serialize() {
    return {
      configuredWatches: [...this.configuredWatches].sort(),
      runtimeWatches: [...this.runtimeWatches].sort(),
      pausedContexts: [...this.paused].sort(),
      residentContexts: [...this.resident].sort(),
      contexts: this.contextStates(),
    }
  }
}

class ContactQueue { // serializes dispatches per contact
  constructor() { this.tail = Promise.resolve() }
  run(fn) {
    this.queued = (this.queued || 0) + 1
    const next = this.tail.then(fn, fn)
    next.finally(() => { this.queued = Math.max(0, (this.queued || 0) - 1) })
    this.tail = next.catch(() => {})
    return next
  }
}

function makeDispatcher({ wsSend, onEscalation, wakes = null, canDispatch = null, isResident = null, residentFactory = null }) {
  const queues = new Map()
  const taskStates = new Map()
  const residents = new Map()
  const makeResident = residentFactory || (() => new CodexResidentAdapter())

  const residentRun = async (name, opts) => {
    let adapter = residents.get(name)
    if (!adapter) { adapter = makeResident(name, opts); residents.set(name, adapter) }
    return adapter.run(name, opts)
  }
  const residentCancel = async name => residents.get(name)?.cancel(name)
  const residentClose = async name => {
    const adapter = residents.get(name)
    if (adapter) {
      if (typeof adapter.closeAll === 'function') await adapter.closeAll()
      else if (typeof adapter.close === 'function') await adapter.close(name)
      residents.delete(name)
    }
    const state = taskStates.get(name)
    if (state && state.active === 0 && state.queued === 0) taskStates.delete(name)
    else if (state) { state.resident = false; state.worker = null; state.session = null }
  }

  const dispatch = function dispatch(agent, msg, extra, opts, contactName) {
    if (typeof opts === 'boolean') opts = { assistant: opts }
    const d = agent.data
    const isOrch = d.type === 'orchestrator'
    const name = isOrch ? d.name : (contactName || msg.from || d.name)
    const isWake = !!(opts && opts.wake)
    if (canDispatch && !canDispatch(name, 'enqueue')) {
      return { code: 0, stdout: '', skipped: true, reason: 'watch-control' }
    }
    // Supersession is resolved inside the per-contact queue, immediately
    // before this task starts. Doing it at enqueue time is too early: the
    // currently-running turn may still publish a wake after this message has
    // arrived, and that late plan must also be superseded by the real message.
    if (!queues.has(name)) queues.set(name, new ContactQueue())
    const queue = queues.get(name)
    if (!taskStates.has(name)) taskStates.set(name, { active: 0, queued: 0, worker: null, session: null })
    taskStates.get(name).queued += 1

    return queue.run(async () => {
      let taskFile = null
      try {
        const state = taskStates.get(name)
        if (state) state.queued = Math.max(0, state.queued - 1)
        if (canDispatch && !canDispatch(name, 'start')) {
          if (wakes) wakes.clear(name)
          return { code: 0, stdout: '', skipped: true, reason: 'watch-control' }
        }
        if (state) state.active += 1

        // Orchestrator agent has FIXED paths (not configurable): it works in
        // the data dir with one dedicated session. Contact agents derive paths
        // from frontmatter (re-resolved per dispatch so edits apply next run).
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
        const useResident = !!(isResident && isResident(name))
        if (useResident && d.harness !== 'codex') throw new Error('resident mode requires the codex harness')
        if (state) {
          state.worker = useResident ? 'resident' : 'process'
          state.session = d.sessionId
          state.resident = useResident
        }
        fs.mkdirSync(base, { recursive: true })
        fs.mkdirSync(d.sessionDir, { recursive: true })
        ensureAgentsMd(base, agent.path)

        taskFile = path.join(base, `.task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`)

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

        if (d.notify && !isOrch && !isWake && msg.from !== 'me' && !opts.recordOnly) {
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

        let superseded = null
        if (isWake) {
          if (!wakes.claim(name, opts.wake.id, opts.wake.version)) {
            return { code: 0, stdout: '', skipped: true }
          }
        } else if (wakes) {
          // A real task supersedes whichever plan is pending at START time,
          // including a wake produced by the task that was ahead of it in
          // this same queue after the real message had already arrived.
          superseded = wakes.take(name) || opts.superseded
        }
        fs.writeFileSync(taskFile, renderTask(msg, extra, { ...opts, superseded }))
        let result
        if (useResident) {
          try {
            result = await residentRun(name, { cwd: base, prompt: fs.readFileSync(taskFile, 'utf8'), timeoutMs })
          } catch (error) {
            result = { code: 1, stdout: String(error && (error.stack || error.message) || error) }
          }
        } else {
          result = await spawnTask()
        }
        const { code, stdout } = result
        if (result.cancelled) {
          if (wakes) wakes.clear(name)
          return { code, stdout, skipped: true, reason: 'resident-cancelled' }
        }
        if (canDispatch && !canDispatch(name, 'continuation')) {
          if (wakes) wakes.clear(name)
          return { code, stdout, skipped: true, reason: 'watch-control' }
        }
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
          // Each completed turn IS the authoritative plan for what happens
          // next: a valid wake replaces the schedule, anything else clears it.
          if (wakes) {
            if (result && result.next_action) {
              wakes.schedule(name, result.next_action, d.name, { sessionId: d.sessionId, sessionDir: d.sessionDir })
            } else {
              if (result && result.next_action_error) log(`next_action rejected for ${name}: ${result.next_action_error} — not scheduling`)
              wakes.clear(name)
            }
          }
        }
        return { code, stdout }
      } finally {
        const state = taskStates.get(name)
        if (state) {
          state.active = Math.max(0, state.active - 1)
          if (state.active === 0 && state.queued === 0) {
            if (state.resident) { state.worker = null; state.session = state.session || null }
            else taskStates.delete(name)
          }
        }
        if (taskFile) { try { fs.unlinkSync(taskFile) } catch {} }
      }
    })
  }
  dispatch.taskStates = () => Object.fromEntries([...taskStates].map(([name, state]) => [name, { ...state }]))
  dispatch.queues = () => Object.fromEntries([...queues].map(([name, queue]) => [name, { queued: queue.queued || 0 }]))
  dispatch.cancelResident = residentCancel
  dispatch.teardownResident = residentClose
  return dispatch
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
  } catch { return null }
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
  const controls = new WatchControlManager({ agents, port })
  const watch = controls.runtimeWatches

  const orchestrator = orchestratorAgent(agents)
  if (!orchestrator) {
    log('WARNING: no agent md with `type: orchestrator` — filehelper messages will be ignored')
  }
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

  const suppressContinuation = (context) => {
    pendingEscalations.delete(context)
    wakes.clear(context)
  }

  const wsSend = (req) => ws ? sendCommand(ws, req).catch(e => log('send failed:', e.message)) : Promise.resolve()

  // Scheduled self-wakeups (worker `next_action`). The orchestrator owns the
  // durable one-pending-wake-per-session store and all timers; a worker only
  // ever *requests* a continuation. Firing reuses the normal dispatch path,
  // so a wake is serialized per contact exactly like a real message task.
  const wakes = new WakeScheduler({ dir: DATA_DIR, dispatchWake: (entry) => fireWake(entry) })

  async function fireWake(entry) {
    if (!controls.isWatched(entry.session) || controls.isPaused(entry.session)) {
      log(`wake for ${entry.session}: dropped by watch control`)
      wakes.claim(entry.session, entry.id, entry.version)
      return
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log(`wake for ${entry.session}: daemon not connected — retrying in 5s`)
      wakes.reschedule(entry, 5000)
      return
    }
    const current = loadAgents()
    if (cliHarness) for (const a of current) a.data.harness = cliHarness
    const isRoom = await isRoomContact(ws, roomCache, entry.session)
    if (isRoom === null) {
      log(`wake for ${entry.session}: contact type lookup failed — retrying in 5s`)
      wakes.reschedule(entry, 5000)
      return
    }
    const recorded = entry.agent ? current.find(a => a.data.name === entry.agent) : null
    const routed = routeAgent(current, entry.session, isRoom)
    const agent = routed && (recorded && recorded.data.type === 'orchestrator'
      ? recorded
      : routed.agent)
    if (!agent) {
      log(`wake for ${entry.session}: no agent routes there any more — dropped`)
      wakes.claim(entry.session, entry.id, entry.version)
      return
    }
    if (!dispatch) { wakes.reschedule(entry, 5000); return }
    const wakeMsg = { from: entry.session, to: 'me', type: 'wake', Content: '', wake: true }
    dispatch(agent, wakeMsg, null, { assistant: false, recordOnly: false, wake: entry }, entry.session)
  }

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

  const contextDetails = (context) => {
    const routed = routeAgent(agents, context, roomCache.get(context) || false)
    const state = controls.contextStates().find(item => item.context === context) || {}
    const task = dispatch ? (dispatch.taskStates()[context] || null) : null
    return {
      ...state,
      agent: routed ? routed.agent.data.name : null,
      mode: routed ? (routed.assistant ? 'assistant' : 'maintainer') : null,
      worker: task && task.worker,
      session: task && task.session,
      task,
      hostRole: 'daemon-client',
    }
  }

  async function buildStatus() {
    agents = loadAgents()
    if (cliHarness) for (const a of agents) a.data.harness = cliHarness
    controls.refreshConfigured(agents)
    let daemon = { connected: !!(ws && ws.readyState === WebSocket.OPEN), port }
    if (daemon.connected) {
      try {
        daemon = { ...daemon, role: 'wechat-daemon', healthy: true, ...(await sendCommand(ws, { cmd: 'daemon-status' })) }
      } catch (error) {
        daemon = { ...daemon, healthy: false, error: error.message }
      }
    } else {
      daemon.healthy = false
    }
    return {
      orchestrator: {
        healthy: !closed,
        startedAt: new Date(controls.startedAt).toISOString(),
        uptimeSeconds: Math.round((Date.now() - controls.startedAt) / 1000),
        agentCount: agents.length,
        agents: agents.map(({ data }) => ({
          name: data.name,
          type: data.type || 'contact',
          harness: data.harness || 'pi',
          contacts: contactList(data),
          contactsAssistant: contactList(data, 'contacts-assistant'),
        })),
        ...controls.serialize(),
        contexts: controls.contextStates().map(({ context }) => contextDetails(context)),
        tasks: dispatch ? { active: dispatch.taskStates(), queues: dispatch.queues() } : { active: {}, queues: {} },
        pendingWakes: wakes.list(),
        pendingEscalations: Object.fromEntries(pendingEscalations),
      },
      daemon,
    }
  }

  const handleControl = async (action, context, options = {}) => {
    const isRoom = await isRoomContact(ws, roomCache, context)
    if (action === 'unwatch' || (action === 'pause' && options.state === 'on')) suppressContinuation(context)
    const result = await controls.handle(action, context, { isRoom: isRoom === true, ...options })
    if (action === 'unwatch' || (action === 'pause' && options.state === 'on')) suppressContinuation(context)
    agents = loadAgents()
    if (cliHarness) for (const a of agents) a.data.harness = cliHarness
    controls.refreshConfigured(agents)
    return result
  }

  const canDispatchTask = (name, phase) => (
    name === (orchestrator && orchestrator.data.name)
      ? true
      : controls.canDispatch(name, phase)
  )

  const onEvent = async (msg) => {
    const ev = msg.event
    if (ev === 'ready' || ev === 'contacts-ready') {
      log('daemon', ev, JSON.stringify(msg.data || {}))
      return
    }
    if (ev === 'lifecycle') {
      log('daemon lifecycle', JSON.stringify(msg.data || {}))
      return
    }
    if (ev === 'orchestrator-request') {
      const { requestId, request } = msg.data || {}
      const respond = (ok, data, error) => wsSend({
        cmd: 'orchestrator-response',
        requestId,
        ok,
        ...(ok ? { data } : { error }),
      })
      try {
        if (!requestId || !request) throw new Error('invalid orchestrator request')
        const result = request.cmd === 'status'
          ? await buildStatus()
          : await handleControl(request.cmd, request.context || request.name || request.to, { agentName: request.agent || null, mode: request.mode || 'maintainer', state: request.state || null })
        await respond(true, result)
      } catch (error) {
        await respond(false, null, error.message)
      }
      return
    }
    if (ev === 'host-discussion') {
      const target = msg.data && msg.data.to
      const prompt = msg.data && msg.data.prompt
      const requestId = msg.data && msg.data.requestId
      const hostResult = (ok, error, data) => requestId && wsSend({ cmd: 'host-result', requestId, ok, error, data })
      if (!target || !prompt) {
        hostResult(false, 'host discussion rejected: missing target or prompt')
        return log('host discussion rejected: missing target or prompt')
      }
      agents = loadAgents()
      if (cliHarness) for (const a of agents) a.data.harness = cliHarness
      const routed = routeAgent(agents, target, await isRoomContact(ws, roomCache, target))
      if (!routed) {
        hostResult(false, `host discussion failed: no routable agent for ${target}`)
        return log(`host discussion failed: no routable agent for ${target}`)
      }
      if (!controls.canDispatch(target)) {
        hostResult(false, `host discussion rejected: ${target} is ${controls.isPaused(target) ? 'paused' : 'not watched'}`)
        return log(`host discussion rejected by watch control: ${target}`)
      }
      log(`host discussion → ${target} via ${routed.agent.data.name}`)
      const superseded = wakes && wakes.take(target)
      hostResult(true, null, { accepted: true, agent: routed.agent.data.name, target })
      dispatch(routed.agent,
        { from: 'host', to: target, type: 'host-discussion', Content: String(prompt) },
        'This is a synthetic HOST DISCUSSION request from the outer orchestrator. Treat the supplied content as rich task context, not as a user message.',
        { assistant: false, recordOnly: false, host: true, superseded }, target)
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
    // session). → any other watched chat: assistant-managed contacts require
    // an explicit `?!`/`？！` ping too; ordinary owner messages are context
    // only. Maintainer-managed contacts only RECORD the owner's message.
    if (data.from === 'me') {
      if (data.to !== 'filehelper' && !watch.has(data.to)) return
      agents = loadAgents()
      if (cliHarness) for (const a of agents) a.data.harness = cliHarness
      controls.refreshConfigured(agents)
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
      if (!controls.canDispatch(data.to)) {
        log('own message recorded but dispatch suppressed by watch control:', data.to)
        return
      }
      const extra = data.type && data.type !== 'text'
        ? 'Non-text message: `content` holds the useful representation (file path for media, URL for emoji, text otherwise).'
        : null
      const text = String(data.Content || data.content || '')
      const ping = text.includes('?!') || text.includes('？！')
      const assistant = routed.assistant && ping
      log(assistant ? 'own message → assistant reply in' : 'own message → context-only into', data.to)
      dispatch(routed.agent, data, extra, {
        assistant: routed.assistant,
        recordOnly: !assistant,
      }, data.to)
      return
    }
    if (!watch.has(data.from)) return

    // Reload agent mds per message so edits apply immediately.
    agents = loadAgents()
    if (cliHarness) for (const a of agents) a.data.harness = cliHarness
    controls.refreshConfigured(agents)
    const routed = routeAgent(agents, data.from, await isRoomContact(ws, roomCache, data.from))
    if (!routed) { log('no agent for', data.from, '— skipping'); return }
    if (!controls.canDispatch(data.from)) {
      log('message recorded but dispatch suppressed by watch control:', data.from)
      return
    }
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
    if (!dispatch) dispatch = makeDispatcher({
      wsSend,
      onEscalation,
      wakes,
      canDispatch: canDispatchTask,
      isResident: context => controls.isResident(context),
    })
    controls.setHooks({
      onPause: context => dispatch && dispatch.cancelResident(context),
      onResidentOff: context => dispatch && dispatch.teardownResident(context),
      onUnwatch: context => dispatch && dispatch.teardownResident(context),
    })
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
    wakes.stop()
    try { ws && ws.close() } catch {}
    if (daemonChild) { try { daemonChild.kill('SIGTERM') } catch {} }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  if (daemonFlag) spawnDaemonChild()
  for (const entry of wakes.list()) {
    if (!controls.isWatched(entry.session)) wakes.take(entry.session)
  }
  wakes.start() // recover persisted wakeups (future → reschedule, overdue → run once)
  await connectLoop()
  log('running — Ctrl-C to stop')
  setInterval(() => {}, 1 << 30) // keep the event loop alive
}

module.exports = {
  parseFrontmatter, loadAgents, loadAgentFile, watchList, routeAgent,
  orchestratorAgent, renderTask, ensureAgentsMd, sanitizeFsName, contactList,
  updateAgentWatchConfig, applyPersistentWatch, WatchControlManager,
  parseTaskResult, shellQuote, defaultHarness, HARNESS_TEMPLATES,
  harnessVars, renderHarness, runOrchestrator, flagValue, DATA_DIR, AGENTS_DIR,
  validateNextAction, clampDelay, WakeScheduler, renderWakeTask, wakeFile,
  ContactQueue, makeDispatcher,
  CodexResidentAdapter,
  WAKE_MIN_SECONDS, WAKE_MAX_SECONDS, WAKE_MAX_OVERDUE_SECONDS, WAKES_FILE,
}
