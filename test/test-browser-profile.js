'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

process.env.WECHAT_BRO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bro-profile-'))
const { getBrowserLaunchOptions, loadCookieBackup } = require('../src/cli.js')

let passed = 0
let failed = 0
function ok(condition, name, extra) {
  if (condition) { passed++; console.log('  ✅', name) }
  else { failed++; console.log('  ❌', name, extra !== undefined ? '— got: ' + JSON.stringify(extra) : '') }
}

async function run() {
  console.log('# browser profile')

  const first = getBrowserLaunchOptions('/tmp/chrome')
  const second = getBrowserLaunchOptions('/tmp/chrome')
  const expectedDir = path.join(process.env.WECHAT_BRO_DATA_DIR, 'browser-profile')
  ok(first.userDataDir === expectedDir, 'initial launch uses the dedicated profile', first.userDataDir)
  ok(second.userDataDir === first.userDataDir, 'recovery reuses the dedicated profile', {
    first: first.userDataDir,
    second: second.userDataDir,
  })

  const cookieFile = path.join(process.env.WECHAT_BRO_DATA_DIR, 'cookies.json')
  const cookie = { name: 'wxsid', value: 'test-only', domain: '.qq.com', path: '/' }
  fs.writeFileSync(cookieFile, JSON.stringify([cookie]))
  const pageCalls = []
  await loadCookieBackup({ setCookie: async (...cookies) => pageCalls.push(cookies) }, cookieFile)
  ok(pageCalls.length === 1 && pageCalls[0][0].name === 'wxsid', 'empty profile fallback loads the cookie checkpoint', pageCalls)

  fs.writeFileSync(cookieFile, JSON.stringify({ cookies: [cookie] }))
  const wrappedCalls = []
  await loadCookieBackup({ setCookie: async (...cookies) => wrappedCalls.push(cookies) }, cookieFile)
  ok(wrappedCalls.length === 1 && wrappedCalls[0].length === 1, 'wrapped cookie backups remain compatible', wrappedCalls)

  try { fs.rmSync(process.env.WECHAT_BRO_DATA_DIR, { recursive: true, force: true }) } catch {}

  console.log('\n--- Results ---')
  console.log('  Passed:', passed)
  console.log('  Failed:', failed)
  process.exit(failed ? 1 : 0)
}

run().catch(error => {
  console.error('FATAL', error)
  process.exit(1)
})
