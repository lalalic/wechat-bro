/**
 * test-orchestrator.js — Unit tests for the orchestrator module:
 * frontmatter parsing, agent loading/seeding, watch list, routing,
 * task rendering, AGENTS.md symlink management, fs-name sanitization.
 *
 * Runs offline — no daemon, no Chrome. Uses a temp WECHAT_BRO_DATA_DIR.
 */

'use strict'

const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bro-orch-test-'))
process.env.WECHAT_BRO_DATA_DIR = tmpDir

const m = require('../src/orchestrator.js')

let pass = 0, fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ok - ${name}`) }
  else { fail++; console.error(`  NOT OK - ${name}`) }
}

// ── parseFrontmatter ──────────────────────────────────────────────────────
console.log('# parseFrontmatter')

const md = `---
name: wechat-alice
description: handles Alice
contacts: [Alice, "Alice Chen"]
type: contact
timeout: 300
notify: true

# comment line
---
Body line one.

Body line two.
`
const { data, body } = m.parseFrontmatter(md)
ok(data.name === 'wechat-alice', 'frontmatter: name')
ok(data.description === 'handles Alice', 'frontmatter: description')
ok(Array.isArray(data.contacts) && data.contacts.length === 2 && data.contacts[1] === 'Alice Chen', 'frontmatter: array with quotes')
ok(data.type === 'contact', 'frontmatter: type')
ok(data.timeout === '300' && data.notify === 'true', 'frontmatter: scalars as strings')
ok(body.startsWith('Body line one.'), 'frontmatter: body after ---')
ok(!('comment' in data) && Object.keys(data).length === 6, 'frontmatter: comments and blanks skipped')

const noFm = m.parseFrontmatter('just body, no frontmatter')
ok(noFm.body === 'just body, no frontmatter' && Object.keys(noFm.data).length === 0, 'frontmatter: absent → body only, empty data')

// ── sanitizeFsName ────────────────────────────────────────────────────────
console.log('# sanitizeFsName')
ok(m.sanitizeFsName('Dev Team') === 'Dev_Team', 'sanitize: spaces → underscore')
ok(m.sanitizeFsName('../etc/passwd') === '_etc_passwd', 'sanitize: traversal blocked')
ok(m.sanitizeFsName('..') === '_', 'sanitize: dot-dot → _')
ok(m.sanitizeFsName('李三/小A') === '李三_小A', 'sanitize: CJK kept, slash replaced')

// ── loadAgents (user dir ~/.wechat-bro/agents + skill defaults) ───────────
console.log('# loadAgents')
const userAgentsDir = path.join(tmpDir, 'agents') // = AGENTS_DIR (WECHAT_BRO_DATA_DIR is tmpDir)
const agents = m.loadAgents()
ok(m.AGENTS_DIR === userAgentsDir, 'loadAgents: user dir is <DATA_DIR>/agents')
ok(agents.length >= 3, 'loadAgents: skill defaults loaded without any user dir')
const names = agents.map(a => a.data.name)
ok(names.includes('wechat-orchestrator') && names.includes('wechat-individual-maintainer') && names.includes('wechat-room-maintainer'), 'loadAgents: all defaults loaded')
ok(agents.find(a => a.data.name === 'wechat-orchestrator').data.type === 'orchestrator', 'loadAgents: orchestrator type')
// user override wins by name
fs.mkdirSync(userAgentsDir, { recursive: true })
fs.writeFileSync(path.join(userAgentsDir, 'wechat-individual-maintainer.agent.md'),
  '---\nname: wechat-individual-maintainer\ntype: contact\ncustom: yes\n---\noverridden body')
const agents2 = m.loadAgents()
const indiv = agents2.find(a => a.data.name === 'wechat-individual-maintainer')
ok(indiv.path.startsWith(userAgentsDir) && indiv.data.custom === 'yes' && indiv.body.trim() === 'overridden body', 'loadAgents: user dir overrides package default by name')

// ── watchList ─────────────────────────────────────────────────────────────
console.log('# watchList')
fs.writeFileSync(path.join(userAgentsDir, 'wechat-alice.agent.md'),
  '---\nname: wechat-alice\ncontacts: [Alice]\n---\nx')
fs.writeFileSync(path.join(userAgentsDir, 'wechat-bob.agent.md'),
  '---\nname: wechat-bob\ncontacts: [Bob]\n---\nx')
const agents3 = m.loadAgents()
const wl = m.watchList(agents3)
ok(wl.has('Alice') && wl.has('Bob') && wl.has('filehelper'), 'watchList: union of contacts + contacts-assistant across agents')

// ── routeAgent (returns {agent, assistant}) ───────────────────────────────
console.log('# routeAgent')
const r1 = m.routeAgent(agents3, 'Alice', false)
ok(r1 && r1.agent.data.name === 'wechat-alice' && r1.assistant === false, 'route: dedicated contacts match wins (maintainer)')
const r2 = m.routeAgent(agents3, 'Somebody', false)
ok(r2 && r2.agent.data.name === 'wechat-individual-maintainer' && r2.assistant === false, 'route: individual fallback for non-room')
const r3 = m.routeAgent(agents3, 'Some Room', true)
ok(r3 && r3.agent.data.name === 'wechat-room-maintainer' && r3.assistant === false, 'route: room fallback for rooms')
ok(m.routeAgent(agents3, 'Stranger', false) !== null, 'route: unlisted contact still falls back to type default (dispatch gate is the watch list)')
const r5 = m.routeAgent(agents3, 'Alice', true)
ok(r5 && r5.agent.data.name === 'wechat-alice' && r5.assistant === false, 'route: dedicated match beats room default')
ok(m.orchestratorAgent(agents3).data.name === 'wechat-orchestrator', 'route: orchestrator agent found by type')

// contacts-assistant: configured assistant-managed contact
console.log('# routeAgent contacts-assistant')
fs.writeFileSync(path.join(userAgentsDir, 'wechat-carol.agent.md'),
  '---\nname: wechat-carol\ncontacts-assistant: [Carol]\n---\nx')
const agents4 = m.loadAgents()
const r6 = m.routeAgent(agents4, 'Carol', false)
ok(r6 && r6.agent.data.name === 'wechat-carol' && r6.assistant === true, 'route: contacts-assistant match → assistant-managed')
ok(m.watchList(agents4).has('Carol'), 'watchList: includes contacts-assistant')

// ── renderTask ────────────────────────────────────────────────────────────
console.log('# renderTask')
const task = m.renderTask({ from: 'Alice', to: 'me', type: 'text', Content: 'hi', ts: 123 }, null)
ok(task.includes('**Alice**') && task.includes('"Content": "hi"'), 'renderTask: from + message JSON embedded')
const task2 = m.renderTask({ from: 'Dev Team', sender: 'Alice', type: 'image' }, 'media note')
ok(task2.includes('sender: Alice') && task2.includes('media note'), 'renderTask: room sender + extra note')

// me-sender modes: assistant chat answers the owner, maintainer chat records
const taskMeAssistant = m.renderTask({ from: 'me', to: 'Carol', type: 'text', Content: 'hi' }, null, { assistant: true, recordOnly: false })
ok(taskMeAssistant.includes('ASSISTANT MODE') && taskMeAssistant.includes('account owner'), 'renderTask: me → assistant chat gets ASSISTANT MODE (owner addressed)')
ok(!taskMeAssistant.includes('Assistant-ping protocol'), 'renderTask: me → assistant chat has no ping-only restriction')
const taskMeRecord = m.renderTask({ from: 'me', to: 'Bob', type: 'text', Content: 'note' }, null, { assistant: false, recordOnly: true })
ok(taskMeRecord.includes('CONTEXT-ONLY MESSAGE') && taskMeRecord.includes('account owner'), 'renderTask: me → maintainer chat recorded context-only')
const taskContactRecord = m.renderTask({ from: 'Carol', to: 'me', type: 'text', Content: 'hi' }, null, { assistant: true, recordOnly: true })
ok(taskContactRecord.includes('CONTEXT-ONLY MESSAGE') && taskContactRecord.includes('?!'), 'renderTask: non-ping contact message keeps assistant-managed wording')

// ── ensureAgentsMd ────────────────────────────────────────────────────────
console.log('# ensureAgentsMd')
const cwd = path.join(tmpDir, 'contacts', 'Alice')
fs.mkdirSync(cwd, { recursive: true })
const agentPath = path.join(userAgentsDir, 'wechat-alice.agent.md')
m.ensureAgentsMd(cwd, agentPath)
ok(fs.readlinkSync(path.join(cwd, 'AGENTS.md')) === agentPath, 'ensureAgentsMd: creates symlink')
m.ensureAgentsMd(cwd, agentPath) // idempotent — same target
ok(fs.readlinkSync(path.join(cwd, 'AGENTS.md')) === agentPath, 'ensureAgentsMd: idempotent when target unchanged')
const other = path.join(userAgentsDir, 'wechat-alice.agent.md') + '.other'
fs.writeFileSync(other, 'other')
m.ensureAgentsMd(cwd, other)
ok(fs.readlinkSync(path.join(cwd, 'AGENTS.md')) === other, 'ensureAgentsMd: refreshes when target changes')

// ── flagValue ─────────────────────────────────────────────────────────────
console.log('# flagValue')
ok(m.flagValue(['orchestrator', '--port', '9500'], '--port') === '9500', 'flagValue: finds value')
ok(m.flagValue(['orchestrator'], '--port') === null, 'flagValue: missing → null')

// ── parseTaskResult (task JSON contract) ──────────────────────────────────
console.log('# parseTaskResult')
ok(m.parseTaskResult('reply sent\n{"status":"addressed"}\n').status === 'addressed', 'result: addressed on last line')
ok(m.parseTaskResult('{"status":"addressed"}\nnoise after\n{"status":"escalated","question":"q?"}\n').status === 'escalated', 'result: scans back to last valid JSON')
ok(m.parseTaskResult('some chatter\nno json here') === null, 'result: no JSON → null (defaults addressed)')
ok(m.parseTaskResult('{"status":"bogus"}') === null, 'result: unknown status → null')
ok(m.parseTaskResult('') === null, 'result: empty stdout → null')
ok(m.parseTaskResult('done\n{bad json}\n{"status":"ignored"}').status === 'ignored', 'result: skips malformed line')

// ── harness templates (defaultHarness / harnessVars / renderHarness) ─────
console.log('# harness templates')
const d0 = { sessionDir: '/s', sessionId: 'wechat-x', cwd: '/c', name: 'wechat-x' }
ok(m.defaultHarness() === m.defaultHarness('pi'), 'defaultHarness: unset → pi')
ok(m.defaultHarness('pi').includes('--session-dir {session-dir}') && m.defaultHarness('pi').includes('--session-id {session-id}'), 'defaultHarness(pi): session vars wired via placeholders')
ok(m.defaultHarness('pi').includes('--thinking off') && m.defaultHarness('pi').includes('--no-skills'), 'defaultHarness(pi): thinking/skills flags baked into template (no frontmatter keys)')
ok(m.defaultHarness('pi').trimEnd().endsWith('@{task}'), 'defaultHarness(pi): task referenced via @{task} (no inline content)')
for (const h of ['claude', 'codex', 'copilot']) {
  const t = m.defaultHarness(h)
  ok(t !== h && t.includes(h), `defaultHarness(${h}): bare name → its built-in template`)
  ok(t.includes('||'), `defaultHarness(${h}): resume-or-first-run fallback baked in`)
  ok(/\{task(-path)?\}/.test(t), `defaultHarness(${h}): task placeholder present`)
}
ok(m.defaultHarness('my-cmd {task}') === 'my-cmd {task}', 'defaultHarness: custom template passes through')

const vars0 = m.harnessVars(d0, { task: 't.md', taskPath: '/c/t.md', contact: 'Alice', timeoutS: 900 })
ok(m.renderHarness(m.defaultHarness('pi'), vars0).includes('@t.md') && m.renderHarness(m.defaultHarness('pi'), vars0).includes('--session-id wechat-x'), 'renderHarness: substitutes task + session-id')
ok(m.renderHarness('{contact}|{timeout}', vars0) === 'Alice|900', 'renderHarness: contact + timeout vars')
ok(m.shellQuote('my task.md') === "'my task.md'", 'shellQuote: quotes values with spaces')
ok(m.renderHarness('run {task}', { task: 'a b.md' }) === "run 'a b.md'", 'renderHarness: shell-quotes unsafe values')
ok(m.renderHarness('echo ${HOME} {task}', { task: 't.md' }).includes('${HOME}'), 'renderHarness: ${VAR} shell form left untouched')
ok(m.renderHarness('x {unknown} y', {}) === 'x {unknown} y', 'renderHarness: unknown placeholder left verbatim')
ok(m.shellQuote("it's") === "'it'\\''s'", 'shellQuote: escapes single quotes')

// ── runOrchestrator startup (no daemon → retries, never crashes) ─────────
// The orchestrator keeps retrying its initial connect every 5s — service
// managers (launchd/systemd) may legitimately start it before the daemon is
// reachable. It must stay alive until SIGTERM.
// (WECHAT_BRO_NO_DAEMON_SPAWN=1 keeps the test from launching a real daemon
// child / Chrome; plain users get the auto-spawn instead of bare retries.)
console.log('# runOrchestrator (no daemon)')
{
  const { spawn: spawnProc } = require('child_process')
  const child = spawnProc(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), 'orchestrator', '--port', '59987'], {
    env: { ...process.env, WECHAT_BRO_DATA_DIR: tmpDir, WECHAT_BRO_NO_DAEMON_SPAWN: '1' },
  })
  let sawRetry = false, exited = null
  child.stderr.on('data', (d) => { if (/retrying every 5s/.test(String(d))) sawRetry = true })
  child.on('exit', (code) => { exited = code })
  setTimeout(() => {
    ok(sawRetry, 'runOrchestrator: logs retry when no daemon (instead of crashing)')
    ok(exited === null, 'runOrchestrator: stays alive retrying without a daemon')
    child.kill('SIGTERM')
    child.on('exit', finish)
  }, 7000)
}

function finish() {
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}
