'use strict'

const assert = require('assert')
const fs = require('fs')
const vm = require('vm')
const bridgeSource = fs.readFileSync(require.resolve('../src/wechat-bro.js'), 'utf8')
const services = { accountFactory: { getUserName: () => '@self' } }
const context = {
  window: {}, console, document: {},
  angular: { element: () => ({ injector: () => ({ get: name => services[name] }) }) },
  MutationObserver: function () {}, setInterval, clearInterval, setTimeout, clearTimeout, Date,
}
context.window.window = context.window
vm.runInNewContext(bridgeSource, context)
const bridge = context.window.WechatyBro
context.WechatyBro = bridge

function match(sent, echo) {
  bridge._sentMsgIds = {}
  bridge._sentMessages = []
  bridge._trackSentMsg(sent)
  return bridge._shouldEmitMessage(echo)
}

assert.strictEqual(match(
  { MsgType: 3, ToUserName: '@alice', MediaId: 'image-media', MsgId: 'local-image' },
  { MsgType: 3, FromUserName: '@self', ToUserName: '@alice', MediaId: 'image-media', MsgId: 'server-image' },
), false, 'changed image MsgId is suppressed by MediaId')
assert.strictEqual(match(
  { MsgType: 43, ToUserName: '@alice', MediaId: 'video-media', MsgId: 'local-video' },
  { MsgType: 43, FromUserName: '@self', ToUserName: '@alice', MediaId: 'video-media', MsgId: 'server-video' },
), false, 'changed video MsgId is suppressed by MediaId')
assert.strictEqual(match(
  { MsgType: 43, ToUserName: 'filehelper', LocalID: '17896200892540129', MsgId: '370373787320504921' },
  { MsgType: 43, FromUserName: '@self', ToUserName: 'filehelper', MsgId: '17896200892540129' },
), false, 'video echo emitted during append is suppressed by LocalID before server MsgId')
bridge._sentMsgIds = {}
bridge._sentMessages = []
bridge._pendingSentMessages = []
bridge._trackPendingSentMsg({ ToUserName: 'filehelper', MsgType: 43, FileName: 'neo-build-log-001-wechat.mp4' })
assert.strictEqual(bridge._shouldEmitMessage({
  MsgType: 43, FromUserName: '@self', ToUserName: 'filehelper', MsgId: '17896212286300717',
}), false, 'WebUploader local video echo is suppressed while its upload is pending')
assert.strictEqual(bridge._pendingSentMessages.length, 0, 'pending upload marker is consumed by its local echo')
assert.strictEqual(match(
  { MsgType: 49, ToUserName: '@alice', FileName: 'report.pdf', FileSize: 1234, MsgId: 'local-file' },
  { MsgType: 49, FromUserName: '@self', ToUserName: '@alice', FileName: 'report.pdf', FileSize: 1234, MsgId: 'server-file' },
), false, 'changed file MsgId is suppressed by filename/filesize')
assert.strictEqual(bridge._sentMessages.length, 0, 'matched media record is consumed once')
assert.strictEqual(bridge._shouldEmitMessage({ MsgType: 49, FromUserName: '@self', ToUserName: '@alice', FileName: 'report.pdf', FileSize: 1234 }), false, 'second echo is not emitted as app noise')

bridge._sentMsgIds = {}
bridge._sentMessages = []
bridge._trackSentMsg({ MsgType: 3, ToUserName: '@alice', MediaId: 'same-media', FileName: 'weak.jpg' })
bridge._trackSentMsg({ MsgType: 3, ToUserName: '@alice', MediaId: 'strong-media', MsgId: 'strong-id' })
assert.strictEqual(bridge._shouldEmitMessage({ MsgType: 3, FromUserName: '@self', ToUserName: '@alice', MediaId: 'same-media', MsgId: 'strong-id' }), false, 'identifier match wins over MediaId match')
assert.strictEqual(bridge._sentMessages.length, 1, 'strongest match consumes only its record')

bridge._sentMsgIds = {}
bridge._sentMessages = []
bridge._trackSentMsg({ MsgType: 3, ToUserName: '@alice', MediaId: 'owner-image' })
assert.strictEqual(bridge._shouldEmitMessage({ MsgType: 3, FromUserName: '@bob', ToUserName: '@alice', MediaId: 'owner-image' }), true, 'non-owner media is not suppressed')
assert.strictEqual(bridge._shouldEmitMessage({ MsgType: 3, FromUserName: '@self', ToUserName: '@bob', MediaId: 'unmatched' }), true, 'unmatched owner media is not suppressed')
assert.strictEqual(bridge._shouldEmitMessage({ MsgType: 49, FromUserName: '@self', ToUserName: '@alice', FileName: 'other.pdf', FileSize: 1234 }), false, 'ordinary app noise remains suppressed')

assert.strictEqual(bridge.isFromAI('hello'), false, 'ordinary text is not AI-originated')
assert.strictEqual(bridge.isFromAI('prefix\u200B\u200C\u200B\u200C hello'), true, 'watermarked AI text remains detectable for suppression')

console.log('ok - injected hook suppresses tracked AI media and preserves owner/unmatched media')
