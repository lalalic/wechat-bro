/**
 * WeChat Media Upload — Node.js-side upload via curl + inject-side send
 *
 * Usage:
 *   const { sendImage, sendFile } = require('./upload')
 *   await sendImage(page, 'contactPyId', fs.readFileSync('photo.jpg'), 'photo.jpg')
 *   await sendFile(page, 'contactPyId', Buffer.from('hello'), 'note.txt')
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
async function uploadMedia(page, to, fileBuffer, filename) {
  const params = await page.evaluate((t) => WechatyBro.getUploadParams(t), to)
  if (!params) throw new Error('getUploadParams returned null — is the contact valid?')

  const cookies = await page.cookies()
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')

  const mimeType = guessMime(filename)
  const mediaType = isImage(mimeType) ? 'pic' : 'doc'
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
    MediaType: 4,
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
 * @param {import('puppeteer-core').Page} page
 * @param {string} to - pyId or UserName
 * @param {Buffer} imageBuffer - image file contents
 * @param {string} [filename='image.png']
 * @returns {Promise<boolean>}
 */
async function sendImage(page, to, imageBuffer, filename) {
  if (!filename) filename = 'image.png'
  const mediaId = await uploadMedia(page, to, imageBuffer, filename)
  return page.evaluate((t, id) => WechatyBro.sendImageWithMediaId(t, id), to, mediaId)
}

/**
 * Send a file to a contact.
 * @param {import('puppeteer-core').Page} page
 * @param {string} to - pyId or UserName
 * @param {Buffer} fileBuffer - file contents
 * @param {string} filename - e.g. 'report.pdf'
 * @returns {Promise<boolean>}
 */
async function sendFile(page, to, fileBuffer, filename) {
  if (!filename) throw new Error('filename is required for sendFile')
  const mediaId = await uploadMedia(page, to, fileBuffer, filename)
  return page.evaluate(
    (t, id, fn, sz) => WechatyBro.sendFileWithMediaId(t, id, fn, sz),
    to, mediaId, filename, fileBuffer.length
  )
}

module.exports = { sendImage, sendFile }
