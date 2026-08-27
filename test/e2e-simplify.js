/**
 * e2e-simplify.js — Live end-to-end verification of non-text event
 * simplification against a real logged-in session (read-only: sends nothing).
 *
 * Bootstraps the REAL pipeline: Angular `message:add:success` broadcast →
 * hookMessageEvents (browser-side download + XML parse) → emit →
 * sendToPuppeteer → cli.js saveBinaryContent + simplifyMessageEvent.
 * Simulated messages are broadcast exactly like real incoming messages.
 */
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const puppeteer = require('puppeteer')

const DATA_DIR = path.join(os.homedir(), '.wechat-bro')
const COOKIE_FILE = path.join(DATA_DIR, 'cookies.json')
const WX_URL = 'https://wx.qq.com'
const INJECT_SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'src', 'wechat-bro.js'), 'utf8')
const { saveBinaryContent, simplifyMessageEvent } = require('/Users/lir/Workspace/free2/wechat-bro/src/cli.js')

const results = []
function record(event, data) {
  const line = { event, data }
  results.push(line)
  console.log('\n=== EVENT:', event, '===\n' + JSON.stringify(line))
}

function findChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ]
  for (const p of candidates) if (fs.existsSync(p)) return p
  return puppeteer.executablePath()
}

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-features=IsolateOrigins,site-per-process'],
    defaultViewport: { width: 1280, height: 900 },
  })
  const page = (await browser.pages())[0]
  page.on('console', m => { const t = m.text(); console.log('[page]', t.slice(0, 220)) })
  page.on('pageerror', e => console.log('[pageerror]', e.message))

  if (fs.existsSync(COOKIE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'))
    const arr = Array.isArray(raw) ? raw : (raw.cookies || [])
    if (arr.length) await page.setCookie(...arr)
  }

  await page.exposeFunction('sendToPuppeteer', (event, data) => {
    // EXACT daemon pipeline (transcribe skipped: no real voiceBase64 in sims)
    try {
      saveBinaryContent(data)
      simplifyMessageEvent(event, data)
      record(event, data)
    } catch (e) {
      console.log('[BRIDGE ERROR]', event, e.message)
    }
  })

  await page.goto(WX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => typeof angular !== 'undefined' && angular.element(document).injector(), { timeout: 30000 })
  await page.evaluate(INJECT_SCRIPT)
  await page.evaluate(() => {
    // Instrument: log every WechatyBro emit
    const orig = window.WechatyBro.emit.bind(window.WechatyBro)
    window.WechatyBro.emit = (ev, d) => { console.log('[EMIT]', ev, d && d.MsgId); return orig(ev, d) }
  })
  await page.evaluate(() => window.WechatyBro.init())
  await page.waitForFunction(() => window.WechatyBro.vars.contactsReady === true, { timeout: 120_000 })
  console.log('✅ Injected + contacts ready — broadcasting simulated incoming messages')

  // Broadcast exactly like real WeChat incoming messages
  const broadcast = (content, msgType, extra) => page.evaluate((content, msgType, extra) => {
    try {
      const rs = window.WechatyBro.glue.rootScope
      const fileHelperUN = window.WechatyBro._requireUserName('filehelper')
      const data = Object.assign({
        MsgId: 'e2e_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        MsgType: msgType,
        Content: content,
        CreateTime: Math.floor(Date.now() / 1000),
        FromUserName: fileHelperUN,
      }, extra || {})
      rs.$broadcast('message:add:success', data)
      return { id: data.MsgId, emojiUrl: data.emojiUrl, appTitle: data.appTitle, cardName: data.cardName }
    } catch (e) { return { error: e.message } }
  }, content, msgType, extra)

  const ids = []
  // 1. text passthrough
  ids.push((await broadcast('plain text hello', 1)).id)
  // 2. emoticon
  ids.push((await broadcast('&lt;msg&gt;<br/>&lt;emoji cdnurl=&quot;https://svgcorp.com/emoji/a.gif?amp;x=1&quot; designid=&quot;&quot; ver=&quot;1&quot; /&gt;<br/>&lt;/msg&gt;', 47)).id)
  // 3. location (label-first attr order, as seen in the wild)
  ids.push((await broadcast('&lt;msg&gt;<br/>&lt;location x="116.32" y="39.99" label="\u4e2d\u5173\u6751\u5927\u88571\u53f7" poiname="\u6d77\u9f99\u5927\u53a6" maptype="roadmap" scale="15" /&gt;<br/>&lt;/msg&gt;', 48)).id)
  // 4. card
  ids.push((await broadcast('&lt;msg cardtype/&gt;', 42, { RecommendInfo: { NickName: '\u738b\u5c0f\u660e' } })).id)
  // 5. app link/article (real article shape)
  ids.push((await broadcast([
    '&lt;msg&gt;<br/>    &lt;appmsg appid=&quot;&quot; sdkver=&quot;0&quot;&gt;<br/>',
    '        &lt;title&gt;&lt;![CDATA[\u201c\u751f\u547d\u4e4b\u6c99\u7ec8\u6709\u8017\u5c3d\u4e4b\u65f6\uff0c\u4f46\u6545\u4e8b\u6c38\u8fdc\u4e0d\u4f1a\u7ed3\u675f\u201d]]&gt;&lt;/title&gt;<br/>',
    '        &lt;des&gt;&lt;![CDATA[]]&gt;&lt;/des&gt;<br/>',
    '        &lt;type&gt;5&lt;/type&gt;<br/>',
    '        &lt;url&gt;&lt;![CDATA[http://mp.weixin.qq.com/s?__biz=MzU1NTcxODQ0OQ==&amp;mid=2247989130&amp;idx=1&amp;sn=abc]]&gt;&lt;/url&gt;<br/>',
    '        &lt;appattach&gt;<br/>            &lt;totallen&gt;0&lt;/totallen&gt;<br/>        &lt;/appattach&gt;<br/>',
    '    &lt;/appmsg&gt;<br/>&lt;/msg&gt;',
  ].join('\n'), 49)).id)
  // 6. app file attachment (appType 6) — fake CDN → download fails → graceful fallback
  ids.push((await broadcast([
    '&lt;msg&gt;<br/>    &lt;appmsg appid=&quot;&quot; sdkver=&quot;0&quot;&gt;<br/>',
    '        &lt;title&gt;&lt;![CDATA[\u6d4b\u8bd5\u6587\u4ef6.pdf]]&gt;&lt;/title&gt;<br/>',
    '        &lt;type&gt;6&lt;/type&gt;<br/>',
    '        &lt;appattach&gt;<br/>',
    '            &lt;totallen&gt;204800&lt;/totallen&gt;<br/>',
    '            &lt;cdnattachurl&gt;&lt;![CDATA[3057020100fake]]&gt;&lt;/cdnattachurl&gt;<br/>',
    '            &lt;cdnmidauthurl&gt;&lt;![CDATA[3057fakeauth]]&gt;&lt;/cdnmidauthurl&gt;<br/>',
    '            &lt;cdnmiddataurl&gt;&lt;![CDATA[3057fakedata]]&gt;&lt;/cdnmiddataurl&gt;<br/>',
    '            &lt;filename&gt;&lt;![CDATA[\u6d4b\u8bd5\u6587\u4ef6.pdf]]&gt;&lt;/filename&gt;<br/>',
    '            &lt;encryver&gt;0&lt;/encryver&gt;<br/>',
    '            &lt;fileext&gt;&lt;![CDATA[pdf]]&gt;&lt;/fileext&gt;<br/>',
    '        &lt;/appattach&gt;<br/>',
    '    &lt;/appmsg&gt;<br/>&lt;/msg&gt;',
  ].join('\n'), 49)).id)
  // 7. system + recalled
  ids.push((await broadcast('"Alice" invited "Bob" to the group', 10000)).id)
  ids.push((await broadcast('&lt;sysmsg type=&quot;revokemsg&quot;&gt;<br/>&lt;revoke&gt;<br/>&lt;newmsgid&gt;3629340428324395&lt;/newmsgid&gt;<br/>&lt;replacemsg&gt;&lt;![CDATA[You recalled a message &quot;hi&quot;]]&gt;&lt;/replacemsg&gt;<br/>&lt;/revoke&gt;<br/>&lt;/sysmsg&gt;', 10002)).id)

  // Wait for async downloads (fake → fast HTTP failures) + emit
  await new Promise(r => setTimeout(r, 5000))

  // ── Assertions (scope to e2e sim MsgIds only — real traffic may arrive) ──
  console.log('\n\n======== ASSERTIONS ========')
  let pass = 0, fail = 0
  const assert = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ✅', name) } else { fail++; console.log('  ❌', name, extra !== undefined ? '— ' + JSON.stringify(extra) : '') }
  }
  const sims = results.filter(r => r.data && typeof r.data.MsgId === 'string' && r.data.MsgId.startsWith('e2e_'))
  const byId = i => sims.find(r => r.data.MsgId === i)

  const text = byId(ids[0])
  assert(text && text.data.Content === 'plain text hello', 'text: raw Content passthrough', text && text.data)

  const emo = byId(ids[1])
  assert(emo && emo.data.content === 'https://svgcorp.com/emoji/a.gif?amp;x=1', 'emoticon: content = cdn url', emo && emo.data)

  const loc = byId(ids[2])
  assert(loc && loc.data.content === '\u4e2d\u5173\u6751\u5927\u88571\u53f7 (\u6d77\u9f99\u5927\u53a6)', 'location: "label (poiname)"', loc && loc.data)

  const card = byId(ids[3])
  assert(card && card.data.content === '[contact card: \u738b\u5c0f\u660e]', 'card: contact name', card && card.data)

  // app / system / recalled are suppressed — no event may arrive
  const suppressedIds = [ids[4], ids[5], ids[6], ids[7]]
  assert(suppressedIds.every(id => !byId(id)), 'app link/file + system + recalled: no events emitted', suppressedIds.map(id => byId(id) && byId(id).event))
  assert(suppressedIds.every(id => !results.some(r => r.data && r.data.MsgId === id)), 'suppressed types absent from all events (incl. jsonl path)')

  const noise = sims.some(r => r.data.MMActualContent !== undefined || r.data.RecommendInfo !== undefined || r.data.ImgStatus !== undefined)
  assert(!noise, 'no wire-format noise in any simplified event')

  const hasEmpty = sims.some(r => Object.keys(r.data).some(k => {
    const v = r.data[k]
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
  }))
  assert(!hasEmpty, 'no empty fields in any emitted event', JSON.stringify(sims.map(r => r.data)))

  assert(sims.length === 4 && sims.every(r => r.data.from && r.data.MsgId) && sims.every(r => r.data.MsgType === 1 || r.data.type), 'exactly 4 sims emitted with identity (+ type on non-text)', sims.length)

  console.log(`\n--- E2E: passed ${pass}, failed ${fail} ---`)
  await browser.close()
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('E2E fatal:', e.message); process.exit(1) })
