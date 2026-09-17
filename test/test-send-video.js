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
      if (evaluateCall === 2) return { found: true, localId: 'upload-1', msgId: 'upload-1', mediaId: '', status: 1, progress: 0, success: 2, fail: 5 }
      if (evaluateCall === 3) return { found: true, localId: 'upload-1', msgId: 'upload-1', mediaId: '', status: 1, progress: 50, success: 2, fail: 5 }
      if (evaluateCall === 4) {
        // Total elapsed time is now > timeoutMs, but upload progress advanced
        // within the timeout window. A wall-clock deadline would fail here.
        return { found: true, localId: 'upload-1', msgId: 'upload-1', mediaId: 'media-1', status: 5, progress: 100, success: 2, fail: 5 }
      }
      if (evaluateCall === 5) return 'send-1'
      if (evaluateCall === 6) return { found: true, status: 2, success: 2, fail: 5, msgId: 'server-msg-1' }
      throw new Error(`unexpected evaluate call ${evaluateCall}`)
    },
    async $() {
      return {
        async uploadFile(file) { uploadedPath = file },
      }
    },
  }

  try {
    const result = await sendVideoFile(page, 'filehelper', video, 'renamed.mp4', 300)
    assert.deepStrictEqual(result, { sent: true, msgId: 'server-msg-1', localId: 'send-1' })
    assert.strictEqual(path.basename(uploadedPath), 'renamed.mp4', 'WebUploader receives the requested filename exactly')
    assert.strictEqual(evaluateCall, 6, 'progress resets the stall timeout before MediaId is reused for send')
    console.log('ok - sendVideoFile tolerates slow progress and waits for server-confirmed video send')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
