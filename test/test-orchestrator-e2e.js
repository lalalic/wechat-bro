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
 *   9. me → assistant-managed contact → context-only unless explicitly pinged
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
const pendingHosts = new Map()

wss.on('connection', (ws) => {
  clients.add(ws)
  ws.send(JSON.stringify({ event: 'connected', data: { clientId: 'e2e' } }))
  ws.send(JSON.stringify({ event: 'ready', data: { loggedIn: true, contactsReady: true } }))
  ws.on('message', (raw) => {
    let req
    try { req = JSON.parse(raw.toString()) } catch { return }
    if (!req.id) return
    if (req.cmd === 'host') {
      const requestId = 'host-' + req.id
      pendingHosts.set(requestId, { ws, id: req.id })
      broadcast('host-discussion', { requestId, to: req.to, prompt: req.prompt })
    } else if (req.cmd === 'host-result') {
      const pending = pendingHosts.get(req.requestId)
      if (pending) {
        pendingHosts.delete(req.requestId)
        pending.ws.send(JSON.stringify(req.ok
          ? { id: pending.id, ok: true, data: req.data }
          : { id: pending.id, ok: false, error: req.error }))
      }
    } else if (req.cmd === 'get-contact') {
      ws.send(JSON.stringify({ id: req.id, ok: true, data: { name: req.id, isRoomContact: req.id === 'Dev Team' || req.id === '三人组' } }))
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
// Restrict bundled generic fallbacks in this fixture so the host no-route
// branch is observable. Dedicated Alice/Bob/Carol/Dave agents still route.
fs.writeFileSync(path.join(agentsDir, 'generic-contact.agent.md'), `---
name: wechat-individual-maintainer
type: contact
contacts: [FixtureOnlyContact]
---
fixture override
`)
fs.writeFileSync(path.join(agentsDir, 'generic-room.agent.md'), `---
name: wechat-room-maintainer
type: room
contacts: [FixtureOnlyRoom]
---
fixture override
`)
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
// Dave exercises the worker `next_action` contract. His harness captures the
// task and only a REAL message requests a follow-up wakeup; the synthetic wake
// task itself returns a plain result, so the continuation ends after one fire.
const daveLog = path.join(tmpDir, 'task-dave.log')
fs.writeFileSync(path.join(agentsDir, 'wechat-dave.agent.md'), `---
name: wechat-dave
description: e2e next-action agent
contacts: [Dave]
type: contact
session-id: e2e-dave-session
harness: cat {task-path} >> ${JSON.stringify(daveLog)} && ( grep -q "SCHEDULED WAKEUP" {task-path} && echo '{"status":"addressed"}' || ( grep -q "HOST DISCUSSION" {task-path} && echo '{"status":"addressed","next_action":{"type":"wake","after_seconds":60,"reason":"Host follow-up with Dave","context":"Continue the hosted workshop discussion only if it still needs a nudge."}}' || echo '{"status":"addressed","next_action":{"type":"wake","after_seconds":6,"reason":"Follow up with Dave","context":"Check whether Dave replied; if the thread is active, stay silent."}}' ) )
cwd: ${path.join(tmpDir, 'contacts', 'Dave')}
---
Dave-specific body.
`)
// 三人组 exercises the dedicated ROOM wake path and host upsert semantics.
const sanrenzuLog = path.join(tmpDir, 'task-sanrenzu.log')
fs.writeFileSync(path.join(agentsDir, 'wechat-sanrenzu.agent.md'), `---
name: wechat-sanrenzu
description: e2e dedicated room host agent
contacts: [三人组]
type: room
session-id: e2e-sanrenzu-session
harness: cat {task-path} >> ${JSON.stringify(sanrenzuLog)} && echo SESSION={session-id} >> ${JSON.stringify(sanrenzuLog)} && if grep -Fq "FLOWCHART-GUIDANCE-UPDATE" {task-path}; then echo '{"status":"addressed"}'; elif grep -q "SCHEDULED WAKEUP" {task-path}; then echo '{"status":"addressed","next_action":{"type":"wake","after_seconds":5,"reason":"room replacement wake","context":"continue the updated room discussion"}}'; else echo '{"status":"addressed","next_action":{"type":"wake","after_seconds":0.3,"reason":"room first wake","context":"resume the 三人组 discussion"}}'; fi
cwd: ${path.join(tmpDir, 'contacts', '三人组')}
---
三人组-specific body.
`)

const sent = []
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const runCli = (args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [ORCH, ...args], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  p.stdout.on('data', c => { stdout += c })
  p.stderr.on('data', c => { stderr += c })
  p.on('close', status => resolve({ status, stdout, stderr }))
})
let child

async function main() {
  // Start the orchestrator as a real subprocess of src/cli.js. Agents come
  // from <WECHAT_BRO_DATA_DIR>/agents (the fixture dir above).
  const spawnOrch = () => spawn('node', [ORCH, 'orchestrator', '--port', String(PORT)], {
    stdio: ['ignore', 'inherit', 'inherit'],
    // Lower the wake minimum so the e2e can exercise real timers quickly.
    env: { ...process.env, WECHAT_BRO_WAKE_MIN_SECONDS: '0.2' },
  })
  child = spawnOrch()
  await sleep(1200) // let it connect

  const wakesFile = path.join(tmpDir, 'pending-wakes.json')
  const pendingWakes = () => { try { return JSON.parse(fs.readFileSync(wakesFile, 'utf8')).wakes || {} } catch { return {} } }

  // 0. host control request → same routed agent/session, synthetic task only.
  const host = await runCli(['host', '--port', String(PORT), '--to', 'Dave', '--prompt', 'Topic: workshop adoption; goal: open a thoughtful discussion.'])
  await sleep(1200)
  ok(host.status === 0 && fs.existsSync(daveLog), 'e2e: host command forwarded to the running orchestrator')
  if (fs.existsSync(daveLog)) {
    const hosted = fs.readFileSync(daveLog, 'utf8')
    ok(hosted.includes('HOST DISCUSSION') && hosted.includes('workshop adoption'), 'e2e: host uses the same room agent with rich context')
    ok(pendingWakes().Dave && pendingWakes().Dave.reason === 'Host follow-up with Dave' && !pendingWakes().Dave.session_id, 'e2e: accepted host result stores contact identity without transient session metadata')
  }
  // Dedicated room host: first start, due wake, then a second host supersedes
  // the replacement wake in the same configured session and ends hosting.
  const roomHost = await runCli(['host', '--port', String(PORT), '--to', '三人组', '--prompt', 'Start the room discussion.'])
  await sleep(700)
  ok(roomHost.status === 0 && fs.existsSync(sanrenzuLog), 'e2e: host starts the dedicated room agent')
  let roomLog = fs.existsSync(sanrenzuLog) ? fs.readFileSync(sanrenzuLog, 'utf8') : ''
  ok(roomLog.includes('HOST DISCUSSION') && roomLog.includes('SESSION=e2e-sanrenzu-session'), 'e2e: room host uses its fixed contact session')
  await sleep(900)
  roomLog = fs.readFileSync(sanrenzuLog, 'utf8')
  ok(roomLog.includes('SCHEDULED WAKEUP') && (roomLog.match(/SESSION=e2e-sanrenzu-session/g) || []).length >= 2, 'e2e: due wake dispatches the same dedicated room session')
  const wakesBeforeRoomUpdate = (roomLog.match(/SCHEDULED WAKEUP/g) || []).length
  const roomUpdate = await runCli(['host', '--port', String(PORT), '--to', '三人组', '--prompt', 'FLOWCHART-GUIDANCE-UPDATE: if useful, add one short flowchart, but do not message merely because guidance changed.'])
  await sleep(500)
  roomLog = fs.readFileSync(sanrenzuLog, 'utf8')
  ok(roomLog.includes('HOST GUIDANCE UPDATE') && roomLog.includes('FLOWCHART-GUIDANCE-UPDATE') && roomLog.includes('Do not assume you must send a message immediately'), 'e2e: second host supersedes the due continuation with authoritative guidance')
  ok((roomLog.match(/SCHEDULED WAKEUP/g) || []).length === wakesBeforeRoomUpdate, 'e2e: updated host omitting next_action ends hosting and old callback never fires')
  ok(!pendingWakes()['三人组'], 'e2e: room host update clears the pending continuation')
  const missingHost = await runCli(['host', '--port', String(PORT), '--to', 'Unknown', '--prompt', 'should fail'])
  ok(missingHost.status !== 0 && missingHost.stdout.includes('no routable agent'), 'e2e: host reports a clear no-route failure')

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

  // 9. me → assistant-managed contact: ordinary owner messages are context-only
  broadcast('message', { from: 'me', to: 'Carol', type: 'text', Content: '提醒我下午三点开会', ts: Date.now() })
  await sleep(1500)
  if (fs.existsSync(out4)) {
    const t = fs.readFileSync(out4, 'utf8')
    ok(t.includes('CONTEXT-ONLY MESSAGE') && t.includes('assistant-managed') && t.includes('no `?!`'), 'e2e: me → assistant-managed chat records ordinary owner message with assistant-managed reason')
    ok(!t.includes('ASSISTANT MODE'), 'e2e: ordinary owner message does NOT trigger assistant mode')
  } else {
    ok(false, 'e2e: own message to assistant-managed contact dispatched')
  }
  ok(sent.filter(s => s.to === 'filehelper' && String(s.content).startsWith('📨 Carol:')).length === 1, 'e2e: notify NOT sent for ordinary owner message')

  // 10. owner `?!` ping → assistant mode
  broadcast('message', { from: 'me', to: 'Carol', type: 'text', Content: '帮我安排一下下午三点开会?!', ts: Date.now() })
  await sleep(1500)
  if (fs.existsSync(out4)) {
    const t = fs.readFileSync(out4, 'utf8')
    ok(t.includes('ASSISTANT MODE') && t.includes('account owner'), 'e2e: me → assistant-managed chat, ?! ping → assistant mode')
    ok(!t.includes('CONTEXT-ONLY MESSAGE'), 'e2e: owner ?! ping is not record-only')
  } else {
    ok(false, 'e2e: owner assistant ping dispatched')
  }

  // 11. a real message before the host wake is due supersedes that plan and
  // the same configured session chooses the replacement continuation.
  broadcast('message', { from: 'Dave', to: 'me', type: 'text', Content: 'should we continue the workshop?', ts: Date.now() })
  await sleep(1200)
  const afterHostReply = fs.readFileSync(daveLog, 'utf8')
  ok(afterHostReply.includes('SUPERSEDED PLAN') && afterHostReply.includes('Host follow-up with Dave'), 'e2e: real message supersedes the pending host wake before due')
  ok(pendingWakes().Dave && pendingWakes().Dave.reason === 'Follow up with Dave' && !pendingWakes().Dave.session_id, 'e2e: same configured contact chooses the replacement next_action')
  ok((afterHostReply.match(/SCHEDULED WAKEUP/g) || []).length === 0, 'e2e: superseded host wake did not fire before the real message')

  // 12. a real incoming message supersedes the pending wakeup BEFORE dispatch
  broadcast('message', { from: 'Dave', to: 'me', type: 'text', Content: 'actually I have an update', ts: Date.now() })
  await sleep(1500)
  const daveTasks = fs.readFileSync(daveLog, 'utf8')
  ok(daveTasks.includes('SUPERSEDED PLAN') && daveTasks.includes('Follow up with Dave'), 'e2e: incoming message injects the cancelled wake as superseded planning context')
  ok(daveTasks.includes('actually I have an update'), 'e2e: the newer message itself still drives the task')
  ok(pendingWakes().Dave && pendingWakes().Dave.version >= 3 && !pendingWakes().Dave.session_id, 'e2e: same configured contact replaced the host wake (version bumped)')

  // 13. restart recovery: the pending wakeup survives, then fires EXACTLY once
  // as a synthetic wake task in the same session.
  child.kill('SIGTERM')
  await sleep(700)
  child = spawnOrch()
  await sleep(1200)
  ok(!!pendingWakes().Dave, 'e2e: pending wakeup survived the orchestrator restart')
  const firedBefore = (fs.readFileSync(daveLog, 'utf8').match(/SCHEDULED WAKEUP/g) || []).length
  await sleep(7000)
  const afterRestart = fs.readFileSync(daveLog, 'utf8')
  const firedAfter = (afterRestart.match(/SCHEDULED WAKEUP/g) || []).length
  ok(firedAfter === firedBefore + 1, 'e2e: recovered wake fired once as a synthetic task (no duplicate)')
  ok(afterRestart.includes('Reason you set: Follow up with Dave'), 'e2e: synthetic wake carried the saved reason + handoff')
  ok(!pendingWakes().Dave, 'e2e: fired wake is consumed from the durable store')

  child.kill('SIGTERM')
  wss.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error(e); child && child.kill(); process.exit(1) })
