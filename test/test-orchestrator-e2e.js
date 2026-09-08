/**
 * test-orchestrator-e2e.js — Integration test for `wechat-bro orchestrator`.
 *
 * Spins a fake wechat-bro daemon (WebSocket server speaking the protocol:
 * broadcast events in, `{id, ok, data}` command responses out) and runs the
 * real orchestrator against it. Verifies the full loop without Chrome, a
 * WeChat login, or pi:
 *
 *   1. watched-contact message  → routed to the dedicated agent, task file
 *      rendered, AGENTS.md symlinked into the contact root, harness template
 *      executed with {task} + {session-id}/{contact} variables expanded
 *   2. me → filehelper guidance → routed to the orchestrator agent in the
 *      data-dir root
 *   3. unwatched contact        → no dispatch
 *   8. me → maintainer-managed contact → context-only record into that session
 *   9. me → assistant-managed contact → assistant mode reply
 *
 * The harness is a `cat {task} > <out>` shell template, so the rendered task
 * file survives the orchestrator's post-dispatch cleanup and can be asserted.
 */

'use strict'

const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bro-orch-e2e-'))
process.env.WECHAT_BRO_DATA_DIR = tmpDir

const WebSocket = require('ws')
const { spawn } = require('child_process')

const PORT = 59991
const ORCH = path.join(__dirname, '..', 'src', 'cli.js')

let pass = 0, fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ok - ${name}`) }
  else { fail++; console.error(`  NOT OK - ${name}`) }
}

// ── Fake daemon ───────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ port: PORT })
const clients = new Set()

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.send(JSON.stringify({ event: 'connected', data: { clientId: 'e2e' } }))
  ws.send(JSON.stringify({ event: 'ready', data: { loggedIn: true, contactsReady: true } }))
  ws.on('message', (raw) => {
    let req
    try { req = JSON.parse(raw.toString()) } catch { return }
    if (!req.id) return
    if (req.cmd === 'get-contact') {
      ws.send(JSON.stringify({ id: req.id, ok: true, data: { name: req.id, isRoomContact: req.id === 'Dev Team' } }))
    } else if (req.cmd === 'send-text') {
      sent.push(req)
      ws.send(JSON.stringify({ id: req.id, ok: true, data: { sent: true } }))
    } else {
      ws.send(JSON.stringify({ id: req.id, ok: true, data: true }))
    }
  })
  ws.on('close', () => clients.delete(ws))
})

function broadcast(event, data) {
  const line = JSON.stringify({ event, data, ts: Date.now() })
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(line)
}

// ── Fixture: agents dir with a dedicated agent + harness template ─────────
const agentsDir = path.join(tmpDir, 'agents')
fs.mkdirSync(agentsDir, { recursive: true })
const out1 = path.join(tmpDir, 'task-alice.md')
const out2 = path.join(tmpDir, 'task-orchestrator.md')
const meta1 = path.join(tmpDir, 'meta-alice.txt')
fs.writeFileSync(path.join(agentsDir, 'wechat-alice.agent.md'), `---
name: wechat-alice
description: e2e dedicated agent
contacts: [Alice]
type: contact
notify: true
harness: cat {task} > ${JSON.stringify(out1)} && echo {session-id} {contact} > ${JSON.stringify(meta1)}
cwd: ${path.join(tmpDir, 'contacts', 'Alice')}
---
Alice-specific body.
`)
fs.writeFileSync(path.join(agentsDir, 'wechat-orchestrator.agent.md'), `---
name: wechat-orchestrator
description: e2e orchestrator
type: orchestrator
contacts: [filehelper]
harness: cat {task} > ${JSON.stringify(out2)}
cwd: ${tmpDir}
session-id: wechat-orchestrator
session-dir: ${path.join(tmpDir, 'session')}
---
Orchestrator body.
`)
// Bob's harness simulates a maintainer that needs the owner's decision:
// captures the task file, then returns the escalation JSON result.
const out3 = path.join(tmpDir, 'task-bob.md')
fs.writeFileSync(path.join(agentsDir, 'wechat-bob.agent.md'), `---
name: wechat-bob
description: e2e escalation agent
contacts: [Bob]
type: contact
harness: cat {task} > ${JSON.stringify(out3)} && echo '{"status":"escalated","question":"Bob asks: can the owner join the Friday call?"}'
cwd: ${path.join(tmpDir, 'contacts', 'Bob')}
---
Bob-specific body.
`)
// Carol is CONFIGURED assistant-managed (contacts-assistant): no ?! needed
// for the mode, but non-ping messages are record-only.
const out4 = path.join(tmpDir, 'task-carol.md')
fs.writeFileSync(path.join(agentsDir, 'wechat-carol.agent.md'), `---
name: wechat-carol
description: e2e assistant-managed contact
contacts-assistant: [Carol]
type: contact
notify: true
harness: cat {task} > ${JSON.stringify(out4)}
cwd: ${path.join(tmpDir, 'contacts', 'Carol')}
---
Carol-specific body.
`)

const sent = []
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function main() {
  // Start the orchestrator as a real subprocess of src/cli.js.
  const child = spawn('node', [ORCH, 'orchestrator', '--port', String(PORT), '--agents-dir', agentsDir], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  await sleep(1200) // let it connect

  // 1. watched contact message
  broadcast('message', { from: 'Alice', to: 'me', type: 'text', Content: 'hello there', ts: Date.now() })
  await sleep(1500)
  ok(fs.existsSync(out1), 'e2e: harness ran for watched contact (task captured)')
  ok(sent.some(s => s.to === 'filehelper' && String(s.content).startsWith('📨 Alice:')), 'e2e: notify → receipt note at dispatch for response-needed message')
  if (fs.existsSync(out1)) {
    const t = fs.readFileSync(out1, 'utf8')
    ok(t.includes('"from": "Alice"') && t.includes('hello there'), 'e2e: task file contains message JSON')
    ok(t.includes('Alice-specific body.') === false, 'e2e: body not inlined into task (via AGENTS.md)')
  }
  const ag = path.join(tmpDir, 'contacts', 'Alice', 'AGENTS.md')
  ok(fs.existsSync(ag) && fs.readlinkSync(ag).endsWith('wechat-alice.agent.md'), 'e2e: AGENTS.md symlinked into contact root')
  ok(fs.existsSync(path.join(tmpDir, 'contacts', 'Alice', 'session')), 'e2e: session dir created in contact root')
  ok(!fs.existsSync(path.join(tmpDir, 'contacts', 'Alice', '.task-')), 'e2e: task file cleaned up after dispatch')
  const meta = fs.existsSync(meta1) ? fs.readFileSync(meta1, 'utf8') : ''
  ok(meta.includes('wechat-Alice') && meta.includes('Alice'), 'e2e: harness template {session-id} and {contact} variables expanded')

  // 1b. `?!` in a contact message = explicit assistant ping → assistant mode
broadcast('message', { from: 'Alice', to: 'me', type: 'text', Content: '你能帮我写周报吗?!', ts: Date.now() })
  await sleep(1500)
  if (fs.existsSync(out1)) {
    const t = fs.readFileSync(out1, 'utf8')
    ok(t.includes('ASSISTANT MODE'), 'e2e: ?! contact message → assistant mode (explicit AI ping)')
    ok(t.includes('Assistant-ping protocol'), 'e2e: assistant ping restricted to the ?! message only')
  } else {
    ok(false, 'e2e: ?! contact message dispatched')
  }

  // 2. user guidance me → filehelper
  broadcast('message', { from: 'me', to: 'filehelper', type: 'text', Content: '以后对 Alice 用正式语气', ts: Date.now() })
  await sleep(1500)
  ok(fs.existsSync(out2), 'e2e: filehelper guidance dispatched to orchestrator agent')
  if (fs.existsSync(out2)) {
    const t = fs.readFileSync(out2, 'utf8')
    ok(t.includes('以后对 Alice 用正式语气'), 'e2e: guidance content in orchestrator task')
    ok(t.includes('ASSISTANT MODE'), 'e2e: filehelper always assistant mode')
  }

  // 3. unwatched contact → no dispatch, no failure
  broadcast('message', { from: 'Stranger', to: 'me', type: 'text', Content: 'spam', ts: Date.now() })
  await sleep(800)
  ok(!fs.existsSync(path.join(tmpDir, 'contacts', 'Stranger')) && !sent.some(s => String(s.content).includes('Stranger')), 'e2e: unwatched contact ignored')

  // 4. old replayed message ignored
  broadcast('message', { from: 'Alice', to: 'me', type: 'text', Content: 'old', ts: 1 })
  await sleep(500)
  const count = fs.readdirSync(path.join(tmpDir, 'contacts', 'Alice')).filter(f => f.startsWith('.task-')).length
  ok(count === 0, 'e2e: replayed (old ts) message not dispatched')

  // 5. escalation via the task JSON result: Bob's harness ends with
  // {"status":"escalated","question":...} → owner notified in fixed format
  broadcast('message', { from: 'Bob', to: 'me', type: 'text', Content: 'can we set up a call?', ts: Date.now() })
  await sleep(1500)
  const esc = sent.find(s => s.to === 'filehelper' && String(s.content).includes('请示'))
  ok(!!esc && String(esc.content).includes('Bob') && String(esc.content).includes('Friday call'), 'e2e: escalation result reported to filehelper in fixed format')

  // 6. owner's reply → routed into the CONTACT's session (recorded + delivered)
  broadcast('message', { from: 'me', to: 'filehelper', type: 'text', Content: '可以，周五的活儿提前交接', ts: Date.now() })
  await sleep(1500)
  const t3 = fs.existsSync(out3) ? fs.readFileSync(out3, 'utf8') : ''
  ok(t3.includes('earlier escalation') && t3.includes('周五的活儿提前交接'), 'e2e: owner reply routed to Bob agent with escalation context')
  ok(fs.existsSync(path.join(tmpDir, 'contacts', 'Bob', 'AGENTS.md')), 'e2e: escalation reply dispatched into Bob root (contactName override)')

  // 7. contacts-assistant config: Carol is assistant-managed.
  // 7a. ordinary message (no ?!) → record-only, no ASSISTANT MODE
  broadcast('message', { from: 'Carol', to: 'me', type: 'text', Content: '今天天气不错', ts: Date.now() })
  await sleep(1500)
  if (fs.existsSync(out4)) {
    const t = fs.readFileSync(out4, 'utf8')
    ok(t.includes('CONTEXT-ONLY MESSAGE') && !t.includes('ASSISTANT MODE'), 'e2e: assistant-managed contact, non-ping message → record-only')
  } else {
    ok(false, 'e2e: assistant-managed contact dispatched')
  }
  const recordNotifies = sent.filter(s => s.to === 'filehelper' && String(s.content).startsWith('📨 Carol:')).length
  ok(recordNotifies === 0, 'e2e: notify NOT sent for context-only (no response needed)')
  // 7b. ?! ping → ASSISTANT MODE
  broadcast('message', { from: 'Carol', to: 'me', type: 'text', Content: '?!帮我查下明天天气', ts: Date.now() })
  await sleep(1500)
  if (fs.existsSync(out4)) {
    const t = fs.readFileSync(out4, 'utf8')
    ok(t.includes('ASSISTANT MODE') && !t.includes('CONTEXT-ONLY MESSAGE'), 'e2e: assistant-managed contact, ?! ping → assistant mode')
  } else {
    ok(false, 'e2e: assistant-managed ping dispatched')
  }
  ok(sent.filter(s => s.to === 'filehelper' && String(s.content).startsWith('📨 Carol:')).length === 1, 'e2e: notify sent for ?! ping (response needed)')

  // 8. me → maintainer-managed contact: recorded context-only in the
  // contact's session (request: maintain mode records the owner's messages)
  broadcast('message', { from: 'me', to: 'Alice', type: 'text', Content: '帮我留意下她的项目进度', ts: Date.now() })
  await sleep(1500)
  if (fs.existsSync(out1)) {
    const t = fs.readFileSync(out1, 'utf8')
    ok(t.includes('CONTEXT-ONLY MESSAGE') && t.includes('account owner'), 'e2e: me → maintainer chat recorded context-only (owner wording)')
    ok(!t.includes('ASSISTANT MODE'), 'e2e: me → maintainer chat does NOT trigger assistant mode')
    ok(fs.existsSync(meta1), 'e2e: own message dispatched into contact session (template re-ran)')
  } else {
    ok(false, 'e2e: own message to maintainer contact dispatched')
  }

  // 9. me → assistant-managed contact: the assistant answers the owner too
  // (request: assistant mode responds to anyone's message, including me)
  broadcast('message', { from: 'me', to: 'Carol', type: 'text', Content: '提醒我下午三点开会', ts: Date.now() })
  await sleep(1500)
  if (fs.existsSync(out4)) {
    const t = fs.readFileSync(out4, 'utf8')
    ok(t.includes('ASSISTANT MODE') && t.includes('account owner'), 'e2e: me → assistant-managed chat gets ASSISTANT MODE reply')
    ok(!t.includes('CONTEXT-ONLY MESSAGE'), 'e2e: me → assistant-managed chat is not record-only')
  } else {
    ok(false, 'e2e: own message to assistant-managed contact dispatched')
  }
  ok(sent.filter(s => s.to === 'filehelper' && String(s.content).startsWith('📨 Carol:')).length === 1, 'e2e: notify NOT sent for owner-originated message (still 1 from the ping)')

  child.kill('SIGTERM')
  wss.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); child && child.kill(); process.exit(1) })
let child
