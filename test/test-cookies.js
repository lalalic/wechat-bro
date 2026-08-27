/**
 * test-cookies.js — Unit tests for cookie persistence (session-loss fix).
 *
 * Verifies saveCookies writes page cookies to disk and saveCookiesOnExit
 * bounds a hung CDP call so process exit is never blocked. Uses temp files —
 * never touches the real ~/.wechat-bro/cookies.json.
 */
'use strict'

const os = require('os')
const path = require('path')
const fs = require('fs')

const { saveCookies, saveCookiesOnExit } = require('../src/cli.js')

let passed = 0
let failed = 0
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✅', name) }
  else { failed++; console.log('  ❌', name, extra !== undefined ? '— got: ' + JSON.stringify(extra) : '') }
}

async function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bro-cookies-'))
  const file = path.join(tmp, 'cookies.json')

  console.log('saveCookies — writes page cookies to disk')
  {
    const fakePage = { cookies: async () => [{ name: 'wx_last_msg_time', value: '1787850333' }, { name: 'wxsid', value: 'abc' }] }
    await saveCookies(fakePage, file)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    ok(Array.isArray(raw) && raw.length === 2 && raw[0].name === 'wx_last_msg_time', 'cookie array persisted', raw)
    ok(raw[0].value === '1787850333', 'replay marker value preserved', raw[0])
  }

  console.log('saveCookies — page.cookies() rejection does not throw, keeps old file')
  {
    fs.writeFileSync(file, 'sentinel')
    const badPage = { cookies: async () => { throw new Error('browser closed') } }
    await saveCookies(badPage, file)  // must not throw
    ok(fs.readFileSync(file, 'utf8') === 'sentinel', 'existing file untouched on failure')
  }

  console.log('saveCookies — concurrent calls are collapsed')
  {
    let calls = 0
    const slowPage = { cookies: async () => { calls++; await new Promise(r => setTimeout(r, 50)); return [] } }
    await Promise.all([saveCookies(slowPage, file), saveCookies(slowPage, file), saveCookies(slowPage, file)])
    ok(calls === 1, 'only one CDP roundtrip while a save is in flight', calls)
  }

  console.log('saveCookiesOnExit — bounds a hung page.cookies() call')
  {
    const hungPage = { cookies: () => new Promise(() => {}) }  // never resolves
    const t0 = Date.now()
    await saveCookiesOnExit(hungPage, 100)
    const elapsed = Date.now() - t0
    ok(elapsed < 1000, 'returned via timeout, not stuck forever', elapsed + 'ms')
  }

  console.log('saveCookiesOnExit — fast save completes before timeout')
  {
    const fastPage = { cookies: async () => [{ name: 'x', value: '1' }] }
    const t0 = Date.now()
    await saveCookiesOnExit(fastPage, 5000)
    ok(Date.now() - t0 < 4000, 'no artificial delay when CDP is healthy')
  }

  console.log('saveCookies — recovers after a hung call (guard auto-resets)')
  {
    const file3 = path.join(tmp, 'recover.json')
    const hungPage = { cookies: () => new Promise(() => {}) }
    await saveCookies(hungPage, file3)           // hangs, guard locked
    await new Promise(r => setTimeout(r, 5300))  // wait out the internal 5s timeout
    const goodPage = { cookies: async () => [{ name: 'recovered', value: 'yes' }] }
    await saveCookies(goodPage, file3)
    const raw = JSON.parse(fs.readFileSync(file3, 'utf8'))
    ok(raw.length === 1 && raw[0].name === 'recovered', 'saves resume after hang timeout', raw)
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

  console.log('\n--- Results ---')
  console.log('  Passed:', passed)
  console.log('  Failed:', failed)
  process.exit(failed ? 1 : 0)
}

run().catch(e => { console.error('FATAL', e); process.exit(1) })
