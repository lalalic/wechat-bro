/**
 * WeChat Media Upload — Node.js-side upload via curl + inject-side send
 *
 * Usage:
 *   const { sendImage, sendVideo, sendFile } = require('./upload')
 *   await sendImage(page, 'contactName', fs.readFileSync('photo.jpg'), 'photo.jpg')
 *   await sendVideo(page, 'contactName', fs.readFileSync('clip.mp4'), 'clip.mp4')
 *   await sendFile(page, 'contactName', Buffer.from('hello'), 'note.txt')
 */

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const CURL = process.platform === 'win32' ? 'curl.exe' : 'curl'

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
}

function guessMime(filename) {
  const ext = path.extname(filename).toLowerCase()
  return MIME_MAP[ext] || 'application/octet-stream'
}

function isImage(mimeType) {
  return mimeType.startsWith('image/')
}

/**
 * Upload a file to file.wx.qq.com via curl (IPv6).
 * Returns the MediaId string, or throws on failure.
 */
async function uploadMedia(page, to, fileBuffer, filename, mediaKind) {
  const params = await page.evaluate((t) => WechatyBro.getUploadParams(t), to)
  if (!params) throw new Error('getUploadParams returned null — is the contact valid?')

  const cookies = await page.cookies()
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  const mimeType = guessMime(filename)
  const mediaType = mediaKind || (isImage(mimeType) ? 'pic' : 'doc')
  const clientMediaId = Date.now().toString() + Math.random().toString(36).substring(2, 8)

  const uploadReq = JSON.stringify({
    UploadType: 2,
    BaseRequest: {
      Uin: params.baseRequest.Uin,
      Sid: params.baseRequest.Sid,
      Skey: params.baseRequest.Skey,
      DeviceID: params.baseRequest.DeviceID,
    },
    ClientMediaId: clientMediaId,
    TotalLen: fileBuffer.length,
    StartPos: 0,
    DataLen: fileBuffer.length,
    MediaType: mediaKind === 'video' ? 2 : 4,
    FromUserName: params.fromUserName,
    ToUserName: params.toUserName,
    FileMd5: '',
  })

  const tmpFile = path.join(os.tmpdir(), 'wx_upload_' + clientMediaId + '_' + filename)
  fs.writeFileSync(tmpFile, fileBuffer)

  const url = params.uploadUrl + '?f=json'

  try {
    const result = execFileSync(CURL, [
      '-6', '-sS', '--max-time', '30',
      '-X', 'POST', url,
      '-H', `Cookie: ${cookieStr}`,
      '-F', 'id=WU_FILE_0',
      '-F', `name=${filename}`,
      '-F', `type=${mimeType}`,
      '-F', `lastModifiedDate=${new Date().toUTCString()}`,
      '-F', `size=${fileBuffer.length}`,
      '-F', `mediatype=${mediaType}`,
      '-F', `uploadmediarequest=${uploadReq}`,
      '-F', `webwx_data_ticket=${params.webwxDataTicket}`,
      '-F', `pass_ticket=${params.passTicket}`,
      '-F', `filename=@${tmpFile};type=${mimeType};filename=${filename}`,
    ], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })

    try { fs.unlinkSync(tmpFile) } catch {}

    const data = JSON.parse(result)
    if (data.BaseResponse && data.BaseResponse.Ret !== 0) {
      throw new Error(`Upload rejected: Ret=${data.BaseResponse.Ret} ${data.BaseResponse.ErrMsg || ''}`)
    }
    if (!data.MediaId) {
      throw new Error('Upload succeeded but no MediaId returned')
    }
    return data.MediaId
  } catch (e) {
    try { fs.unlinkSync(tmpFile) } catch {}
    throw e
  }
}

/**
 * Send an image to a contact.
 * @param {import('puppeteer').Page} page
 * @param {string} to - name or UserName
 * @param {Buffer} imageBuffer - image file contents
 * @param {string} [filename='image.png']
 * @returns {Promise<boolean>}
 */
async function sendImage(page, to, imageBuffer, filename) {
  if (!filename) filename = 'image.png'
  const mediaId = await uploadMedia(page, to, imageBuffer, filename, 'pic')
  return page.evaluate((t, id) => WechatyBro.sendImageWithMediaId(t, id), to, mediaId)
}


/**
 * Send a native video message through WeChat Web's own WebUploader.
 * The generic curl uploader is unreliable for videos on current wx.qq.com:
 * it can return an empty body even though the browser uploader works.
 * This path waits for both MediaId assignment and server-side send success.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} to - name or UserName
 * @param {string} filePath - local video path
 * @param {string} [filename='video.mp4']
 * @param {number} [timeoutMs=60000]
 * @returns {Promise<{sent:boolean,msgId:string,localId:string}>}
 */
async function sendVideoFile(page, to, filePath, filename, timeoutMs = 60000) {
  if (!filename) filename = path.basename(filePath) || 'video.mp4'
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`)

  let uploadPath = filePath
  let tempDir = null
  if (path.basename(filePath) !== filename) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx_video_'))
    uploadPath = path.join(tempDir, filename)
    fs.copyFileSync(filePath, uploadPath)
  }

  try {
    const baseline = await page.evaluate((target) => {
      const injector = angular.element(document).injector()
      const chatFactory = injector.get('chatFactory')
      const contactFactory = injector.get('contactFactory')
      const rootScope = injector.get('$rootScope')
      const userName = WechatyBro._requireUserName(target)
      const contact = contactFactory.getContact(userName)
      if (!contact) throw new Error(`contact not found: ${target}`)
      contactFactory.setCurrentContact(contact)
      chatFactory.setCurrentUserName(userName)
      try { rootScope.$evalAsync() } catch (e) {}
      const existing = (chatFactory.getChatMessage(userName) || []).map((m) => String(m.LocalID || m.ClientMsgId || m.MsgId || ''))
      return { userName, existing }
    }, to)

    await new Promise(resolve => setTimeout(resolve, 150))
    const input = await page.$('input[type=file]')
    if (!input) throw new Error('WeChat Web file input not found')
    await input.uploadFile(uploadPath)

    const deadline = Date.now() + timeoutMs
    let localId = null
    while (Date.now() < deadline) {
      const state = await page.evaluate(({ userName, existing, expectedName }) => {
        const injector = angular.element(document).injector()
        const chatFactory = injector.get('chatFactory')
        const confFactory = injector.get('confFactory')
        const success = confFactory.MSG_SEND_STATUS_SUCC
        const fail = confFactory.MSG_SEND_STATUS_FAIL
        const messages = chatFactory.getChatMessage(userName) || []
        const msg = [...messages].reverse().find((m) => {
          const id = String(m.LocalID || m.ClientMsgId || m.MsgId || '')
          return m.MsgType === confFactory.MSGTYPE_VIDEO && !existing.includes(id) && (!expectedName || !m.FileName || m.FileName === expectedName)
        })
        if (!msg) return { found: false, success, fail }
        return {
          found: true,
          localId: String(msg.LocalID || msg.ClientMsgId || ''),
          msgId: String(msg.MsgId || ''),
          mediaId: msg.MediaId || '',
          status: msg.MMStatus,
          success,
          fail,
        }
      }, { ...baseline, expectedName: filename })

      if (state.found) {
        localId = state.localId
        if (state.status === state.success && state.msgId) {
          return { sent: true, msgId: state.msgId, localId }
        }
        if (state.mediaId) break
        if (state.status === state.fail) throw new Error('WeChat rejected video upload before MediaId was assigned')
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }

    if (!localId) throw new Error('video upload timed out before WeChat created a local message')

    const sendLocalId = await page.evaluate(({ userName, uploadLocalId }) => {
      const injector = angular.element(document).injector()
      const chatFactory = injector.get('chatFactory')
      const confFactory = injector.get('confFactory')
      const uploaded = (chatFactory.getChatMessage(userName) || []).find((m) => String(m.LocalID || m.ClientMsgId || '') === uploadLocalId)
      if (!uploaded) throw new Error('uploaded video message disappeared before send')
      if (!uploaded.MediaId) throw new Error('uploaded video has no MediaId')
      const msg = chatFactory.createMessage({
        ToUserName: userName,
        MsgType: confFactory.MSGTYPE_VIDEO || 43,
        MediaId: uploaded.MediaId,
        Content: '',
      })
      chatFactory.appendMessage(msg)
      chatFactory.postVideoMessage(msg)
      return String(msg.LocalID || msg.ClientMsgId || '')
    }, { userName: baseline.userName, uploadLocalId: localId })
    if (!sendLocalId) throw new Error('failed to start video send')

    while (Date.now() < deadline) {
      const state = await page.evaluate(({ userName, sendLocalId }) => {
        const injector = angular.element(document).injector()
        const chatFactory = injector.get('chatFactory')
        const confFactory = injector.get('confFactory')
        const msg = (chatFactory.getChatMessage(userName) || []).find((m) => String(m.LocalID || m.ClientMsgId || '') === sendLocalId)
        if (!msg) return { found: false }
        return {
          found: true,
          status: msg.MMStatus,
          success: confFactory.MSG_SEND_STATUS_SUCC,
          fail: confFactory.MSG_SEND_STATUS_FAIL,
          msgId: String(msg.MsgId || ''),
        }
      }, { userName: baseline.userName, sendLocalId })
      if (state.found && state.status === state.success && state.msgId) {
        return { sent: true, msgId: state.msgId, localId: sendLocalId }
      }
      if (state.found && state.status === state.fail) throw new Error('WeChat rejected video message')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('video send confirmation timed out')
  } finally {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
    }
  }
}

/**
 * Buffer-compatible wrapper used by programmatic callers.
 */
async function sendVideo(page, to, videoBuffer, filename) {
  if (!filename) filename = 'video.mp4'
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx_video_buffer_'))
  const tempFile = path.join(tempDir, filename)
  fs.writeFileSync(tempFile, videoBuffer)
  try {
    return await sendVideoFile(page, to, tempFile, filename)
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
  }
}

/**
 * Send a file to a contact.
 * @param {import('puppeteer').Page} page
 * @param {string} to - name or UserName
 * @param {Buffer} fileBuffer - file contents
 * @param {string} filename - e.g. 'report.pdf'
 * @returns {Promise<boolean>}
 */
async function sendFile(page, to, fileBuffer, filename) {
  if (!filename) throw new Error('filename is required for sendFile')
  const mediaId = await uploadMedia(page, to, fileBuffer, filename, 'doc')
  return page.evaluate(
    (t, id, fn, sz) => WechatyBro.sendFileWithMediaId(t, id, fn, sz),
    to, mediaId, filename, fileBuffer.length
  )
}

module.exports = { uploadMedia, sendImage, sendVideo, sendVideoFile, sendFile }
