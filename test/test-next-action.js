/**
 * test-next-action.js — Focused tests for the worker `next_action` /
 * scheduled self-wakeup primitive:
 *
 *   1. parse/validation  — parseTaskResult stays backward compatible; a valid
 *      `next_action.wake` is normalized; an invalid one is rejected (never
 *      silently scheduled).
 *   2. bounds            — clampDelay enforces min/max worker delay.
 *   3. persistence       — WakeScheduler persists one pending wake per session.
 *   4. replace/cancel    — each turn replaces, `clear`/`take` cancels; stale
 *      timer callbacks for a replaced schedule are ignored.
 *   5. restart/overdue   — a restarted scheduler recovers a pending wake and
 *      fires it once; an overdue wake inside the grace window fires once; one
 *      stale beyond it is dropped.
 *   6. serialization     — a wake runs through the same ContactQueue as a real
 *      message for that contact (never concurrently); a real message cancels
 *      the pending wake and injects it as superseded planning context.
 *
 * Runs offline (no daemon, no Chrome, no network) with a temp data dir.
 */

'use strict'

const os = require('os')
const path = require('path')
const fs = require('fs')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bro-next-action-'))
process.env.WECHAT_BRO_DATA_DIR = tmpDir

const m = require('../src/orchestrator.js')

let pass = 0, fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ok - ${name}`) }
  else { fail++; console.error(`  NOT OK - ${name}`) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))


async function main() {
  // ── 1. parse / validation ─────────────────────────────────────────────────
  console.log('# parseTaskResult — backward compatible')
  ok(m.parseTaskResult('done\n{"status":"addressed"}').status === 'addressed', 'old result line unchanged (addressed)')
  ok(m.parseTaskResult('{"status":"ignored"}').status === 'ignored', 'old result line unchanged (ignored)')
  const esc = m.parseTaskResult('{"status":"escalated","question":"q?"}')
  ok(esc.status === 'escalated' && esc.question === 'q?' && !('next_action' in esc), 'escalated unchanged, no next_action key added')
  ok(m.parseTaskResult('{"status":"bogus"}') === null, 'unknown status still rejected')

  console.log('# parseTaskResult — optional next_action')
  const wake = m.parseTaskResult('{"status":"addressed","next_action":{"type":"wake","after_seconds":1800,"reason":"  check room  ","context":"if silent, ask a follow-up"}}')
  ok(wake.next_action && wake.next_action.type === 'wake' && wake.next_action.after_seconds === 1800, 'valid wake parsed')
  ok(wake.next_action.reason === 'check room', 'reason trimmed')
  ok(wake.next_action.context === 'if silent, ask a follow-up', 'context preserved')
  const noMeta = m.parseTaskResult('{"status":"addressed","next_action":{"type":"wake","after_seconds":60}}')
  ok(noMeta.next_action.reason === '' && noMeta.next_action.context === '', 'missing reason/context → empty strings')
  const explicitNull = m.parseTaskResult('{"status":"addressed","next_action":null}')
  ok(!('next_action' in explicitNull), 'explicit null next_action treated as absent')

  console.log('# parseTaskResult — invalid next_action never schedules')
  for (const [label, line] of [
    ['unknown type', '{"status":"addressed","next_action":{"type":"cron","after_seconds":60}}'],
    ['missing type', '{"status":"addressed","next_action":{"after_seconds":60}}'],
    ['missing after_seconds', '{"status":"addressed","next_action":{"type":"wake"}}'],
    ['zero after_seconds', '{"status":"addressed","next_action":{"type":"wake","after_seconds":0}}'],
    ['negative after_seconds', '{"status":"addressed","next_action":{"type":"wake","after_seconds":-5}}'],
    ['non-numeric after_seconds', '{"status":"addressed","next_action":{"type":"wake","after_seconds":"soon"}}'],
    ['array next_action', '{"status":"addressed","next_action":[1,2]}'],
  ]) {
    const r = m.parseTaskResult(line)
    ok(r && r.status === 'addressed' && r.next_action === null && !!r.next_action_error, `rejected: ${label}`)
  }
  ok(m.validateNextAction(undefined).action === null && m.validateNextAction(undefined).error === null, 'validateNextAction: absent → no action, no error')
  ok(m.validateNextAction({ type: 'wake', after_seconds: 5 }).action.after_seconds === 5, 'validateNextAction: valid → normalized')

  // ── 2. bounds ─────────────────────────────────────────────────────────────
  console.log('# clampDelay')
  ok(m.clampDelay(1, { minSeconds: 30, maxSeconds: 600 }).seconds === 30, 'below min → clamped up')
  ok(!!m.clampDelay(1, { minSeconds: 30, maxSeconds: 600 }).clamped, 'clamp is reported')
  ok(m.clampDelay(9999, { minSeconds: 30, maxSeconds: 600 }).seconds === 600, 'above max → clamped down')
  ok(m.clampDelay(120, { minSeconds: 30, maxSeconds: 600 }).seconds === 120, 'in range → untouched')
  ok(m.WAKE_MIN_SECONDS > 0 && m.WAKE_MAX_SECONDS > m.WAKE_MIN_SECONDS, 'module defaults are sane')
  ok(m.WakeScheduler.toString().length > 0 && m.WAKES_FILE === 'pending-wakes.json', 'scheduler + store filename exported')

  // ── 3/4/5. scheduler: persistence, replace, cancel, stale, restart ─────────
  console.log('# WakeScheduler — persistence & replacement')
  const sdir = path.join(tmpDir, 'wakes-1')
  fs.mkdirSync(sdir, { recursive: true })
  const fired = []
  const sched = new m.WakeScheduler({
    dir: sdir, minSeconds: 0.02, maxSeconds: 5, maxOverdueSeconds: 60,
    dispatchWake: (e) => fired.push(e),
  })
  const r1 = sched.schedule('Alice', { type: 'wake', after_seconds: 3, reason: 'first', context: 'ctx-1' }, 'wechat-alice')
  ok(r1.entry && r1.entry.version === 1, 'first schedule → version 1')
  const onDisk = JSON.parse(fs.readFileSync(m.wakeFile(sdir), 'utf8'))
  ok(onDisk.wakes.Alice && onDisk.wakes.Alice.reason === 'first' && onDisk.wakes.Alice.due_at > Date.now(), 'persisted to pending-wakes.json with a future due_at')
  ok(onDisk.wakes.Alice.session === 'Alice' && onDisk.wakes.Alice.agent === 'wechat-alice', 'entry records session + agent identity')

  const r2 = sched.schedule('Alice', { type: 'wake', after_seconds: 2, reason: 'second', context: 'ctx-2' }, 'wechat-alice')
  ok(r2.entry.version === 2 && sched.list().length === 1, 'replacement keeps ONE pending wake, version bumped')
  ok(r2.entry.id !== r1.entry.id, 'replacement gets a fresh schedule id')
  ok(sched.schedule('Clamp', { type: 'wake', after_seconds: 1, reason: 'in-range' }).entry.after_seconds === 1, 'in-bounds request not clamped')

  console.log('# WakeScheduler — stale callback & cancel')
  sched._fire('Alice', r1.entry.id, r1.entry.version) // stale: replaced by r2
  ok(fired.length === 0, 'stale callback (old id/version) does not fire')
  ok(!!sched.get('Alice'), 'stale callback left the current schedule intact')
  const taken = sched.take('Alice')
  ok(taken && taken.id === r2.entry.id && sched.get('Alice') === null, 'take() cancels and returns the entry')
  ok(JSON.parse(fs.readFileSync(m.wakeFile(sdir), 'utf8')).wakes.Alice === undefined, 'cancellation is persisted')
  sched.schedule('Bob', { type: 'wake', after_seconds: 3, reason: 'b' })
  sched.clear('Bob')
  ok(sched.get('Bob') === null, 'clear() removes a pending wake')
  ok(m.WakeScheduler.prototype.take !== undefined, 'scheduler API present')

  console.log('# WakeScheduler — fire once, then clear')
  const firedOnce = []
  const s2 = new m.WakeScheduler({ dir: path.join(tmpDir, 'wakes-2'), minSeconds: 0.02, maxSeconds: 5, maxOverdueSeconds: 60, dispatchWake: (e) => firedOnce.push(e) })
  s2.schedule('Carol', { type: 'wake', after_seconds: 0.05, reason: 'soon', context: 'h' })
  await sleep(200)
  ok(firedOnce.length === 1 && firedOnce[0].session === 'Carol' && firedOnce[0].reason === 'soon', 'a due wake fires exactly once with its handoff')
  ok(s2.get('Carol') !== null, 'a due wake remains durable until claimed')
  ok(s2.claim('Carol', firedOnce[0].id, firedOnce[0].version), 'the exact due wake can be claimed')
  ok(s2.get('Carol') === null, 'a claimed wake is consumed')
  ok(JSON.parse(fs.readFileSync(m.wakeFile(path.join(tmpDir, 'wakes-2')), 'utf8')).wakes.Carol === undefined, 'claimed wake is gone from disk')

  console.log('# WakeScheduler — restart recovery (future)')
  const rdir = path.join(tmpDir, 'wakes-restart')
  const sA = new m.WakeScheduler({ dir: rdir, minSeconds: 0.02, maxSeconds: 60, maxOverdueSeconds: 600, dispatchWake: () => {} })
  sA.schedule('Dave', { type: 'wake', after_seconds: 0.4, reason: 'restart-me', context: 'handoff-x' })
  sA.stop() // simulate process exit before due
  const sB = new m.WakeScheduler({ dir: rdir, minSeconds: 0.02, maxSeconds: 60, maxOverdueSeconds: 600, dispatchWake: (e) => fired.push(e) })
  ok(sB.get('Dave') && sB.get('Dave').version === 1, 'restarted scheduler reloads the pending wake')
  sB.start()
  await sleep(600)
  ok(fired.filter(e => e.session === 'Dave').length === 1, 'recovered future wake fires exactly once after restart')
  ok(sB.get('Dave') !== null, 'recovered wake remains durable until claimed')
  ok(sB.claim('Dave', fired.find(e => e.session === 'Dave').id, fired.find(e => e.session === 'Dave').version), 'recovered wake can be claimed exactly once')
  sB.start() // idempotent re-arm must not duplicate
  await sleep(120)
  ok(fired.filter(e => e.session === 'Dave').length === 1, 're-arming after restart never duplicates')

  console.log('# WakeScheduler — overdue recovery & grace')
  const odir = path.join(tmpDir, 'wakes-overdue')
  fs.mkdirSync(odir, { recursive: true })
  const overdueFired = []
  fs.writeFileSync(m.wakeFile(odir), JSON.stringify({ version: 1, wakes: {
    Erin: { id: 'e1', version: 1, session: 'Erin', agent: 'wechat-erin', due_at: Date.now() - 2000, reason: 'overdue', context: 'c' },
  } }))
  const sO = new m.WakeScheduler({ dir: odir, minSeconds: 0.02, maxSeconds: 60, maxOverdueSeconds: 300, dispatchWake: (e) => overdueFired.push(e) })
  sO.start()
  await sleep(150)
  ok(overdueFired.length === 1 && overdueFired[0].session === 'Erin', 'overdue wake inside the grace window fires once promptly')

  const gdir = path.join(tmpDir, 'wakes-grace')
  fs.mkdirSync(gdir, { recursive: true })
  const graceFired = []
  fs.writeFileSync(m.wakeFile(gdir), JSON.stringify({ version: 1, wakes: {
    Frank: { id: 'f1', version: 4, session: 'Frank', agent: 'wechat-frank', due_at: Date.now() - 10 * 60 * 1000, reason: 'stale', context: 'c' },
  } }))
  const sG = new m.WakeScheduler({ dir: gdir, minSeconds: 0.02, maxSeconds: 60, maxOverdueSeconds: 60, dispatchWake: (e) => graceFired.push(e) })
  sG.start()
  await sleep(120)
  ok(graceFired.length === 0, 'wake overdue beyond the grace window is NOT replayed')
  ok(sG.get('Frank') === null, 'dropped stale wake is removed from the store')

  // ── 6. serialization + supersede through the dispatcher ───────────────────
  console.log('# ContactQueue — per-contact serialization')
  {
    const q = new m.ContactQueue()
    const order = []
    const p1 = q.run(async () => { order.push('a-start'); await sleep(60); order.push('a-end') })
    const p2 = q.run(async () => { order.push('b-start'); order.push('b-end') })
    await Promise.all([p1, p2])
    ok(order.join(',') === 'a-start,a-end,b-start,b-end', 'queued work runs strictly after the previous task (no overlap)')
  }

  console.log('# dispatcher — wake runs through the same queue; message supersedes it')
  const workDir = path.join(tmpDir, 'dispatch')
  fs.mkdirSync(workDir, { recursive: true })
  const logFile = path.join(workDir, 'harness.log')
  const helper = path.join(workDir, 'harness.sh')
  fs.writeFileSync(helper, [
    '#!/bin/sh',
    'contact="$1"; task="$2"; log="$3"',
    'echo "START $contact" >> "$log"',
    'sleep 0.35',
    'echo "TASK $contact" >> "$log"',
    'cat "$task" >> "$log"',
    'echo "END $contact" >> "$log"',
    `echo '{"status":"addressed"}'`,
    '',
  ].join('\n'))

  const agentMd = path.join(workDir, 'wechat-dave.agent.md')
  fs.writeFileSync(agentMd, '---\nname: wechat-dave\ncontacts: [Dave]\n---\nbody')
  const wakeAgent = {
    path: agentMd,
    data: { name: 'wechat-dave', type: 'contact', harness: `sh ${helper} {contact} {task-path} ${logFile}`, cwd: workDir },
  }
  const wakeSched = new m.WakeScheduler({ dir: workDir, minSeconds: 0.02, maxSeconds: 60, maxOverdueSeconds: 60, dispatchWake: () => {} })
  const escalations = []
  const dispatch = m.makeDispatcher({ wsSend: async () => {}, onEscalation: (c, q) => escalations.push([c, q]), wakes: wakeSched })

  wakeSched.schedule('Dave', { type: 'wake', after_seconds: 600, reason: 'pending-plan', context: 'check the thread' }, 'wechat-dave')
  const msg = { from: 'Dave', to: 'me', type: 'text', Content: 'any update?', ts: Date.now() }
  const wakeEntry = wakeSched.get('Dave')
  const pMsg = dispatch(wakeAgent, msg, null, {}, 'Dave')
  const pWake = dispatch(wakeAgent, { from: 'Dave', to: 'me', type: 'wake', Content: '', wake: true }, null, { wake: wakeEntry }, 'Dave')
  await Promise.all([pMsg, pWake])

  const log = fs.readFileSync(logFile, 'utf8')
  const started = log.split('\n').filter(l => l.startsWith('START ')).length
  ok(started === 1, 'a queued wake superseded by a real message is skipped')
  ok(log.includes('SUPERSEDED PLAN') && log.includes('pending-plan') && log.includes('check the thread') && log.includes('any update?'), 'real message cancels the wake and injects it as superseded planning context')
  ok(wakeSched.get('Dave') === null, 'superseded wake is gone from the store')
  ok(!log.includes('SCHEDULED WAKEUP'), 'stale queued wake does not run')

  console.log('# dispatcher — result drives the schedule')
  const schedDir = path.join(tmpDir, 'dispatch-results')
  fs.mkdirSync(schedDir, { recursive: true })
  const resSched = new m.WakeScheduler({ dir: schedDir, minSeconds: 0.02, maxSeconds: 60, maxOverdueSeconds: 60, dispatchWake: () => {} })
  const dispatch2 = m.makeDispatcher({ wsSend: async () => {}, onEscalation: () => {}, wakes: resSched })
  function resultAgent(name, contactName, json) {
    const p = path.join(schedDir, `${name}.agent.md`)
    fs.writeFileSync(p, `---\nname: ${name}\ncontacts: [${contactName}]\n---\nbody`)
    return { path: p, data: { name, type: 'contact', cwd: schedDir, harness: `printf '%s' ${JSON.stringify(json)}` } }
  }
  const wakeResultAgent = resultAgent('wechat-w1', 'W1', '{"status":"addressed","next_action":{"type":"wake","after_seconds":42,"reason":"later","context":"handoff"}}')
  await dispatch2(wakeResultAgent, { from: 'W1', to: 'me', type: 'text', Content: 'hi' }, null, {}, 'W1')
  ok(resSched.get('W1') && resSched.get('W1').reason === 'later' && resSched.get('W1').after_seconds === 42, 'a wake result schedules the next continuation')

  const clearAgent = resultAgent('wechat-w2', 'W2', '{"status":"addressed"}')
  resSched.schedule('W2', { type: 'wake', after_seconds: 600, reason: 'old' }, 'wechat-w2')
  await dispatch2(clearAgent, { from: 'W2', to: 'me', type: 'text', Content: 'hi' }, null, {}, 'W2')
  ok(resSched.get('W2') === null, 'a valid result WITHOUT next_action clears the pending continuation')

  const badAgent = resultAgent('wechat-w3', 'W3', '{"status":"addressed","next_action":{"type":"wake","after_seconds":-1}}')
  await dispatch2(badAgent, { from: 'W3', to: 'me', type: 'text', Content: 'hi' }, null, {}, 'W3')
  ok(resSched.get('W3') === null, 'an INVALID next_action never silently schedules')

  const escAgent = resultAgent('wechat-w4', 'W4', '{"status":"escalated","question":"decide?"}')
  await dispatch2(escAgent, { from: 'W4', to: 'me', type: 'text', Content: 'hi' }, null, {}, 'W4')
  ok(escalations.length === 0, 'escalation via a second dispatcher stays local to it')

  wakeSched.stop(); sched.stop(); s2.stop(); sO.stop(); sG.stop(); resSched.stop()

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
