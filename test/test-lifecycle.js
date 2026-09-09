#!/usr/bin/env node
'use strict'

/**
 * test-lifecycle.js — offline tests for `wechat-bro up|down` primitives.
 * No Chrome, no real WeChat, no real daemon: a mock ws server plays the
 * daemon (sends the `connected` event like ws-server.js does), and a real
 * `cli.js orchestrator` child plays the orchestrator (it only needs a ws
 * endpoint; against the mock it idles harmlessly).
 *
 * WECHAT_BRO_DATA_DIR is pointed at a temp dir so pidfiles never touch the
 * real ~/.wechat-bro.
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const WebSocket = require('ws')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bro-lifecycle-test-'))
process.env.WECHAT_BRO_DATA_DIR = TMP
// lifecycle.js reads DATA_DIR from env at require time — set env first.
const lifecycle = require('../src/lifecycle')
const { probeDaemon, waitDaemon, readAlivePid, ensureUp, shutDown, writePid, clearPid } = lifecycle

const PORT = 19231
const ok = (name) => console.log(`  ✓ ${name}`)
let mockServer, mockClientCount = 0

async function startMockDaemon() {
  return new Promise((resolve) => {
    mockServer = new WebSocket.Server({ port: PORT }, resolve)
    mockServer.on('connection', (ws) => {
      mockClientCount++
      ws.send(JSON.stringify({ event: 'connected', data: { clientId: 't', serverId: 'wechat-bro' } }))
      // Behave like the real ws-server: reply to commands by id (needed for
      // the `exit` handshake in shutDown).
      ws.on('message', (raw) => {
        try { const m = JSON.parse(raw.toString()); if (m.id) ws.send(JSON.stringify({ ok: true, id: m.id, data: {} })) } catch {}
      })
    })
  })
}

async function main() {
  // ── pidfile roundtrip ───────────────────────────────────────────────────
  writePid('daemon')
  // readAlivePid guards against pid reuse by checking the cmdline is a
  // cli.js process — this test process is not, so it must NOT be returned.
  assert.strictEqual(readAlivePid('daemon'), null, 'foreign pid must be rejected by cmdline guard')
  ok('pidfile written, foreign cmdline rejected')

  fs.writeFileSync(path.join(TMP, 'orchestrator.pid'), '999999999')
  assert.strictEqual(readAlivePid('orchestrator'), null)
  ok('stale pidfile (dead pid) rejected')

  // ── probe: no daemon ────────────────────────────────────────────────────
  assert.strictEqual(await probeDaemon(PORT, 300), false)
  ok('probe: nothing listening → false')

  // ── up against a mock daemon: daemon seen as running, orchestrator spawned ──
  await startMockDaemon()
  assert.strictEqual(await probeDaemon(PORT), true)
  ok('probe: mock daemon answers `connected` → true')

  const up1 = await ensureUp({ port: PORT, timeoutMs: 5000 })
  assert.strictEqual(up1.ok, true)
  assert.deepStrictEqual(up1.daemon, { running: true }, 'existing daemon must not be respawned')
  assert.strictEqual(up1.orchestrator.started, true)
  ok('up: daemon kept, orchestrator spawned detached')

  // ── the spawned orchestrator registers itself in its pidfile ────────────
  let opid = null
  for (let i = 0; i < 50 && !opid; i++) {
    opid = readAlivePid('orchestrator')
    if (!opid) await new Promise(r => setTimeout(r, 100))
  }
  assert.ok(opid, 'orchestrator pidfile must become readable (real cli.js child)')
  ok(`up: orchestrator tracked via pidfile (pid ${opid})`)

  // ── up is idempotent: second run starts nothing ─────────────────────────
  for (let i = 0; i < 50 && mockClientCount < 1; i++) await new Promise(r => setTimeout(r, 100))
  assert.ok(mockClientCount >= 1, 'orchestrator should have connected to the mock')
  const clientsBefore = mockClientCount
  await new Promise(r => setTimeout(r, 200))
  const up2 = await ensureUp({ port: PORT, timeoutMs: 5000 })
  assert.strictEqual(up2.ok, true)
  assert.strictEqual(up2.daemon.running, true)
  assert.strictEqual(up2.orchestrator.started, undefined, 'second up must not respawn orchestrator')
  assert.strictEqual(up2.orchestrator.pid, opid)
  // Only ensureUp's own probe opens a new connection (each probe counts once
  // in the mock) — a respawned orchestrator would add a second one.
  assert.strictEqual(mockClientCount - clientsBefore, 1, 'only the probe connects — no orchestrator respawn')
  ok('up: idempotent second run')

  // ── orchestrator reconnects through the mock (sanity, no crash) ─────────
  // (its initial connect succeeded against the mock — no retry loop needed)

  // ── down: stops orchestrator (SIGTERM) and daemon (WS exit) ─────────────
  const down = await shutDown({ port: PORT })
  assert.strictEqual(down.ok, true)
  assert.strictEqual(down.orchestrator.stopped, true, 'orchestrator stopped')
  for (let i = 0; i < 30 && readAlivePid('orchestrator'); i++) await new Promise(r => setTimeout(r, 100))
  assert.strictEqual(readAlivePid('orchestrator'), null, 'orchestrator really gone')
  assert.strictEqual(down.daemon.graceful, true, 'daemon stopped via WS exit')
  await new Promise(r => mockServer.close(r))
  assert.strictEqual(await probeDaemon(PORT, 300), false)
  ok('down: orchestrator SIGTERMed, daemon closed via WS exit')

  // ── down with nothing running is still ok ───────────────────────────────
  const down2 = await shutDown({ port: PORT })
  assert.strictEqual(down2.ok, true)
  assert.strictEqual(down2.daemon.running, false)
  ok('down: nothing running → still ok')

  // ── waitDaemon timeout path ─────────────────────────────────────────────
  assert.strictEqual(await waitDaemon(PORT, 800), false)
  ok('waitDaemon: timeout → false')

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log('\nAll lifecycle tests passed.')
  process.exit(0)
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
