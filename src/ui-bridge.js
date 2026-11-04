'use strict'
const crypto = require('crypto')

/**
 * Per-page management bridge. The browser gets neither file paths nor shell
 * access; it supplies only allowlisted requests to the Node controller.
 * A per-page secret in the injected IIFE's private closure prevents unrelated
 * site scripts from making raw management requests via Runtime.addBinding.
 */
function createManagementBridge({
  controller, source, isActive,
  origin = 'https://wx.qq.com', log = () => {},
} = {}) {
  if (!controller || typeof controller.handle !== 'function') throw Error('UI controller required')
  if (typeof source !== 'string' || !source.includes('__WB_UI_NONCE__')) throw Error('UI source has no nonce placeholder')
  if (typeof isActive !== 'function') throw Error('isActive callback required')
  const secrets = new WeakMap()
  const allowedPage = page => {
    try { return isActive(page) && new URL(page.url()).origin === origin && !page.closed }
    catch { return false }
  }

  async function attach(page) {
    const secret = crypto.randomBytes(24).toString('hex')
    secrets.set(page, secret)
    await page.exposeFunction('wechatBroUiBridge', async (nonce, id, payload) => {
      let reply
      try {
        if (!allowedPage(page)) throw Error('UI unavailable outside WeChat')
        if (nonce !== secret) throw Error('unauthorized WeChat UI request')
        if (typeof id !== 'string' || !/^u[0-9]{1,10}$/.test(id)) throw Error('invalid UI request ID')
        reply = { ok: true, data: await controller.handle(payload) }
      } catch (error) { reply = { ok: false, error: error.message } }
      try {
        if (allowedPage(page) && typeof id === 'string' && /^u[0-9]{1,10}$/.test(id)) {
          await page.evaluate((requestId, result) => {
            if (typeof window.__wechatBroUiResponse === 'function') {
              window.__wechatBroUiResponse(requestId, result)
            }
          }, id, reply)
        }
      } catch (error) { log('Management UI response dropped:', error.message) }
    })
  }

  async function mount(page) {
    if (!allowedPage(page)) return false
    const secret = secrets.get(page)
    if (!secret) throw Error('management bridge must be attached before mount')
    await page.evaluate(source.replace('__WB_UI_NONCE__', secret))
    return true
  }
  return { attach, mount }
}
module.exports = { createManagementBridge }
