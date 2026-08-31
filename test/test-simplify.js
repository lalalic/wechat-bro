/**
 * test-simplify.js — Unit tests for non-text event simplification.
 *
 * Exercises the real saveBinaryContent + simplifyMessageEvent from cli.js
 * with realistic payloads (shapes taken from actual messages.jsonl events).
 * Binary payloads are replaced with tiny valid base64 so nothing large is
 * written; real files land in a temp DOWNLOAD_DIR — override before requiring
 * cli.js.
 */

'use strict'

const os = require('os')
const path = require('path')
const fs = require('fs')

// Redirect DATA_DIR-dependent paths before requiring cli.js — cli.js honors
// WECHAT_BRO_DATA_DIR so tests never touch the real ~/.wechat-bro.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bro-test-'))
process.env.WECHAT_BRO_DATA_DIR = tmpDir
const CONTACTS_DIR = path.join(tmpDir, 'contacts')

const mod = require('../src/cli.js')
// cli.js computes DOWNLOAD_DIR at require-time from ~/.wechat-bro — patch the
// module-internal reference via re-saving into that directory (accept the
// real dir) OR monkey-patch fs. Simplest: tests that hit disk assert on the
// returned path and verify the file exists wherever it points.
const saveBinaryContent = mod.saveBinaryContent
const simplifyMessageEvent = mod.simplifyMessageEvent

let passed = 0
let failed = 0

function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✅', name) }
  else { failed++; console.log('  ❌', name, extra !== undefined ? '— got: ' + JSON.stringify(extra) : '') }
}

// tiny 1x1 png
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

console.log('simplifyMessageEvent — text passes through unchanged')
{
  const data = { MsgType: 1, Content: 'hello', from: 'Alice', to: 'me', MsgId: '1', MMActualContent: 'hello' }
  simplifyMessageEvent('message:text', data)
  ok(data.Content === 'hello' && data.MMActualContent === 'hello', 'text fields untouched', data)
  ok(data.content === undefined, 'no simplified content for text', data)
}

console.log('simplifyMessageEvent — image with downloaded file')
{
  const data = {
    MsgType: 3, MsgId: '459', CreateTime: 1787850333,
    Content: '&lt;msg&gt;XML SOUP&lt;/msg&gt;', imageFile: '/x/.wechat-bro/download/459.jpg',
    imageBase64: PNG_B64, ImgStatus: 2, RecommendInfo: {}, from: 'Alice', to: 'me',
  }
  simplifyMessageEvent('message:image', data)
  ok(data.content === '/x/.wechat-bro/download/459.jpg', 'content = image file path', data)
  ok(data.type === 'image', 'type exposed', data)
  ok(data.Content === undefined && data.ImgStatus === undefined && data.RecommendInfo === undefined, 'noise stripped', data)
  ok(data.from === 'Alice' && data.MsgId === '459' && data.ts === 1787850333, 'identity fields kept', data)
}

console.log('simplifyMessageEvent — image download failed')
{
  const data = { MsgType: 3, Content: 'x', from: 'A' }
  simplifyMessageEvent('message:image', data)
  ok(data.content === '[image download failed]', 'fallback marker', data)
}

console.log('simplifyMessageEvent — voice with transcription')
{
  const data = { MsgType: 34, Content: 'x', voiceFile: '/d/1.amr', voiceText: '明天开会', from: 'A' }
  simplifyMessageEvent('message:voice', data)
  ok(data.content === '明天开会', 'content = transcribed text', data)
  ok(data.voiceFile === '/d/1.amr', 'voiceFile kept', data)
}

console.log('simplifyMessageEvent — voice without transcription')
{
  const data = { MsgType: 34, Content: 'x', voiceFile: '/d/1.amr', from: 'A' }
  simplifyMessageEvent('message:voice', data)
  ok(data.content === '/d/1.amr', 'content falls back to file path', data)
}

console.log('simplifyMessageEvent — video downloaded / failed')
{
  const okData = { MsgType: 43, Content: 'x', videoFile: '/d/2.mp4', FileName: 'v.mp4', from: 'A' }
  simplifyMessageEvent('message:video', okData)
  ok(okData.content === '/d/2.mp4', 'content = video path', okData)

  const bad = { MsgType: 43, Content: 'x', FileName: 'clip.mp4', FileSize: '1024000', from: 'A' }
  simplifyMessageEvent('message:video', bad)
  ok(bad.content.includes('[video not downloaded') && bad.content.includes('clip.mp4'), 'fallback mentions filename', bad)
}

console.log('simplifyMessageEvent — app/system/recalled suppressed entirely')
{
  const appFile = { MsgType: 49, appType: 6, Content: 'xml', fileName: 'report.pdf', from: 'A' }
  ok(simplifyMessageEvent('message:app', appFile) === false, 'app file → suppressed (false)', appFile)
  ok(appFile.fileName === 'report.pdf' && appFile.content === undefined, 'suppressed data untouched', appFile)

  const appLink = { MsgType: 49, appType: 5, Content: 'xml', appTitle: 'T', appUrl: 'http://x', from: 'A' }
  ok(simplifyMessageEvent('message:app', appLink) === false, 'app link → suppressed (false)', appLink)

  const appUnknown = { MsgType: 49, from: 'A' }
  ok(simplifyMessageEvent('message:app', appUnknown) === false, 'app unknown subtype → suppressed', appUnknown)

  const sys = { MsgType: 10000, Content: '"Alice" invited "Bob"', from: 'A' }
  ok(simplifyMessageEvent('message:system', sys) === false, 'system → suppressed', sys)

  const rec = { MsgType: 10002, Content: '<sysmsg type="revokemsg"/>', from: 'A' }
  ok(simplifyMessageEvent('message:recalled', rec) === false, 'recalled → suppressed', rec)

  const verify = { MsgType: 37, Content: 'x', from: 'A' }
  ok(simplifyMessageEvent('message:verify', verify) === true && verify.content === 'x', 'verify still emitted (readable text)', verify)
}

console.log('simplifyMessageEvent — empty fields stripped (text passthrough)')
{
  const data = { MsgType: 1, Content: 'hello', FileName: '', MediaId: '', Url: null, OriContent: '', from: 'Alice', to: null, ForwardFlag: 0, mentions: [] }
  simplifyMessageEvent('message:text', data)
  ok(data.Content === 'hello' && data.from === 'Alice', 'meaningful fields kept', data)
  ok(data.FileName === undefined && data.MediaId === undefined && data.Url === undefined, 'empty strings/nulls dropped', data)
  ok(data.to === undefined && data.mentions === undefined, 'null + empty array dropped', data)
  ok(data.ForwardFlag === 0, 'zero value kept (not empty)', data)
}

console.log('simplifyMessageEvent — empty fields stripped (non-text)')
{
  const data = { MsgType: 47, Content: 'x', emojiUrl: 'https://x/a.gif', from: 'A', to: null, sender: undefined }
  simplifyMessageEvent('message:emoticon', data)
  ok(data.content === 'https://x/a.gif' && data.type === 'emoticon', 'essentials kept', data)
  const emptyKeys = Object.keys(data).filter(k => data[k] === undefined || data[k] === null || data[k] === '' || (Array.isArray(data[k]) && !data[k].length))
  ok(emptyKeys.length === 0, 'no empty fields remain', emptyKeys)
}
{
  const data = { MsgType: 48, Content: 'x', location: 'somewhere', from: 'A', to: null, mentions: [], mentionMe: false }
  simplifyMessageEvent('message:location', data)
  ok(data.to === undefined && data.mentions === undefined, 'empty identity/mentions dropped', data)
  ok(data.mentionMe === false, 'false kept', data)
}

console.log('simplifyMessageEvent — emoticon / location / card')
{
  const emo = { MsgType: 47, Content: 'x', emojiUrl: 'https://emoji.cdn/a.gif', from: 'A' }
  simplifyMessageEvent('message:emoticon', emo)
  ok(emo.content === 'https://emoji.cdn/a.gif', 'emoticon → url', emo)

  const loc = { MsgType: 48, Content: 'x', location: '中关村大街1号 (海龙大厦)', from: 'A' }
  simplifyMessageEvent('message:location', loc)
  ok(loc.content === '中关村大街1号 (海龙大厦)', 'location → readable', loc)

  const card = { MsgType: 42, Content: 'x', cardName: '王小明', from: 'A' }
  simplifyMessageEvent('message:card', card)
  ok(card.content === '[contact card: 王小明]', 'card → name', card)
}

console.log('simplifyMessageEvent — room fields preserved')
{
  const data = {
    MsgType: 3, imageFile: '/d/4.jpg', from: 'Dev Team', sender: 'Alice',
    mentions: ['Bob'], mentionMe: true, to: 'me',
  }
  simplifyMessageEvent('message:image', data)
  ok(data.sender === 'Alice' && data.mentions[0] === 'Bob' && data.mentionMe === true, 'room identity kept', data)
}

console.log('saveBinaryContent — per-contact folder, <filename>_<id>.<ext>')
{
  const data = { MsgType: 43, videoBase64: PNG_B64, MsgId: '777', FileName: 'clip.mp4', from: 'Alice' }
  saveBinaryContent(data)
  const expected = path.join(CONTACTS_DIR, 'Alice', 'download', 'clip_777.mp4')
  ok(data.videoFile === expected, 'original filename + MsgId in contact folder', data.videoFile)
  ok(data.videoBase64 === undefined, 'base64 field removed', data)
  ok(fs.existsSync(data.videoFile), 'file actually written', data.videoFile)
}

console.log('saveBinaryContent — no FileName → default stem, room msg → room folder')
{
  const data = { MsgType: 34, voiceBase64: PNG_B64, MsgId: '888', from: 'Dev Team', sender: 'Bob' }
  saveBinaryContent(data)
  const expected = path.join(CONTACTS_DIR, 'Dev Team', 'download', 'voice_888.amr')
  ok(data.voiceFile === expected, 'room message lands in room folder', data.voiceFile)
}

console.log('saveBinaryContent — self-sent (from=me) → peer folder')
{
  const data = { MsgType: 3, imageBase64: PNG_B64, MsgId: '999', from: 'me', to: 'Alice' }
  saveBinaryContent(data)
  const expected = path.join(CONTACTS_DIR, 'Alice', 'download', 'image_999.jpg')
  ok(data.imageFile === expected, 'self-sent media in peer folder', data.imageFile)
}

console.log('saveBinaryContent — null/empty base64 skipped')
{
  const data = { videoBase64: null, imageBase64: '' }
  saveBinaryContent(data)
  ok(data.videoFile === undefined && data.imageFile === undefined, 'nothing written', data)
}

// cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}

console.log('\n--- Results ---')
console.log('  Passed:', passed)
console.log('  Failed:', failed)
process.exit(failed ? 1 : 0)
