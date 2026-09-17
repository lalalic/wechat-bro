'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { sendVideoFile } = require('../src/upload')

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-bro-video-test-'))
  const video = path.join(dir, 'clip.mp4')
  fs.writeFileSync(video, Buffer.from('fake-mp4'))

  let evaluateCall = 0
  let uploadedPath = null
  const page = {
    async evaluate() {
      evaluateCall++
      if (evaluateCall === 1) return { userName: 'filehelper', existing: [] }
      if (evaluateCall === 2) {
        // Native WebUploader can mark its own local placeholder failed while
        // still yielding a valid MediaId. sendVideoFile must continue.
        return { found: true, localId: 'upload-1', msgId: 'upload-1', mediaId: 'media-1', status: 5, success: 2, fail: 5 }
      }
      if (evaluateCall === 3) return 'send-1'
      if (evaluateCall === 4) return { found: true, status: 2, success: 2, fail: 5, msgId: 'server-msg-1' }
      throw new Error(`unexpected evaluate call ${evaluateCall}`)
    },
    async $() {
      return {
        async uploadFile(file) { uploadedPath = file },
      }
    },
  }

  try {
    const result = await sendVideoFile(page, 'filehelper', video, 'renamed.mp4', 2000)
    assert.deepStrictEqual(result, { sent: true, msgId: 'server-msg-1', localId: 'send-1' })
    assert.strictEqual(path.basename(uploadedPath), 'renamed.mp4', 'WebUploader receives the requested filename exactly')
    assert.strictEqual(evaluateCall, 4, 'upload MediaId is reused in a fresh server-side video send')
    console.log('ok - sendVideoFile waits for MediaId and server-confirmed video send')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
