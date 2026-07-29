# wechat-bro

AI multi-agent interface for WeChat Web. Injects into [wx.qq.com](https://wx.qq.com) and exposes a WebSocket protocol for multi-agent automation.

**Works with**: Any WebSocket client (agent frameworks, Copilot extensions, custom scripts).

## Architecture

```
                    ┌──────────────────┐
 Agent A ──ws──────→│                  │
 Agent B ──ws──────→│  src/cli.js      │──→ wx.qq.com
 Agent C ──ws──────→│  (long‑lived)    │──→ Chrome
                    └──────────────────┘
                           │
                           ▼ stdout (events + backward compat stdin)
                           ▼ ~/.wechat-bro/messages.jsonl
```

**Files:**

| Path | Role |
|---|---|
| `src/wechat-bro.js` | Browser-side script. Injects `window.WechatyBro` into wx.qq.com. |
| `src/cli.js` | WebSocket server (port 9231) + stdin interface for AI agents. |
| `src/ws-server.js` | WebSocket server module with multi-agent broadcast. |
| `src/upload.js` | Media upload via `curl -6`. Exports `sendImage()`, `sendFile()`. |
| `src/transcribe.js` | Voice transcription via Whisper STT. |
| `test/test-inject.js` | 102 integration tests with real Chrome + WeChat account. |
| `SKILL.md` | Agent skill documentation (commands, protocol, events). |

## Install

```bash
npm install
```

Auto-detects system Chrome/Chromium on macOS, Linux, and Windows. If none is found, downloads Chromium automatically to `~/.wechat-bro/chromium/`.

## Quick Start

```bash
# First run (will show QR code for login):
wechat-bro --headed

# Subsequent runs — headless with saved cookies:
wechat-bro

# Connect agents via WebSocket:
ws://localhost:9231
```

Events stream as JSON lines to stdout:
```jsonl
{"event":"scan","data":{"code":0,"url":"https://login.weixin.qq.com/qrcode/...","loginUrl":"https://login.weixin.qq.com/l/..."}}
{"event":"login","data":{"id":"licheng","name":"李诚","NickName":"李诚"}}
{"event":"contacts-ready","data":{"total":248,"personal":221,"withPinyin":221,"elapsedMs":1003}}
{"event":"message","data":{"MsgType":1,"Content":"hello","from":{"name":"Alice","id":"alice"}}}
{"event":"message","data":{"MsgType":1,"Content":"hey all","from":{"name":"Dev Team","id":"devteam","isRoomContact":true},"sender":{"name":"Alice","id":"alice"},"mentions":[],"mentionMe":false}}
{"event":"message:text","data":{"MsgType":1,"Content":"hello"}}
{"event":"logout","data":"..."}
```

### Option 2: With Puppeteer

```js
const puppeteer = require('puppeteer')
const fs = require('fs')
const { sendImage, sendFile } = require('./src/upload')

const INJECT = fs.readFileSync('./src/wechat-bro.js', 'utf-8')

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
})
const page = await browser.newPage()

// Expose the event bridge BEFORE injection
await page.exposeFunction('sendToPuppeteer', (event, data) => {
  console.log('EVENT:', event, data)
})

await page.goto('https://wx.qq.com', { waitUntil: 'domcontentloaded' })

// Wait for Angular to bootstrap
await page.waitForFunction(
  () => typeof angular !== 'undefined' && angular.element(document).injector(),
  { timeout: 30000 }
)

// Inject the bridge
await page.evaluate(INJECT)
await page.evaluate(() => WechatyBro.init())

// --- After login + contacts-ready event ---

// Send text (supports emoji codes)
await page.evaluate(() => WechatyBro.send('alice', 'Hello! [Smile][Rose]'))

// Send image (upload happens in Node.js, send happens in browser)
const imgBuf = fs.readFileSync('photo.jpg')
await sendImage(page, 'alice', imgBuf, 'photo.jpg')

// Send file
const pdfBuf = fs.readFileSync('report.pdf')
await sendFile(page, 'alice', pdfBuf, 'report.pdf')
```

### Option 3: With Playwright

```js
const { chromium } = require('playwright')
const fs = require('fs')

const INJECT = fs.readFileSync('./src/wechat-bro.js', 'utf-8')

const browser = await chromium.launch({ headless: false })
const page = await browser.newPage()

// Playwright equivalent of exposeFunction
await page.exposeFunction('sendToPuppeteer', (event, data) => {
  console.log('EVENT:', event, data)
})

await page.goto('https://wx.qq.com', { waitUntil: 'domcontentloaded' })
await page.waitForFunction(
  () => typeof angular !== 'undefined' && angular.element(document).injector()
)

await page.evaluate(INJECT)
await page.evaluate(() => WechatyBro.init())
```

> **Note**: `src/upload.js` uses Puppeteer's `page.cookies()` and `page.evaluate()` APIs. For Playwright, you'll need to adapt the cookie extraction: `await context.cookies()`.

### Option 4: In Electron

```js
// main.js
const { BrowserWindow } = require('electron')
const fs = require('fs')
const INJECT = fs.readFileSync('./src/wechat-bro.js', 'utf-8')

const win = new BrowserWindow({
  webPreferences: { contextIsolation: false, nodeIntegration: false },
})

// Expose the event bridge
win.webContents.executeJavaScript(`
  window.sendToPuppeteer = function(event, data) {
    require('electron').ipcRenderer.send('wechat-event', event, data)
  }
`)

// Listen for events in main process
const { ipcMain } = require('electron')
ipcMain.on('wechat-event', (e, event, data) => {
  console.log('WeChat event:', event, data)
})

win.loadURL('https://wx.qq.com')

// After page load + Angular ready
win.webContents.executeJavaScript(INJECT)
win.webContents.executeJavaScript('WechatyBro.init()')
```

> **Note**: With `contextIsolation: true` (default in modern Electron), use `contextBridge.exposeInMainWorld` in a preload script instead.

### Option 5: In iOS WebKit (WKWebView)

WKWebView doesn't have Puppeteer's `exposeFunction` or `page.evaluate`. Communication uses `WKScriptMessageHandler` for events (browser → native) and `evaluateJavaScript` for API calls (native → browser).

#### Setup

```swift
import WebKit

class WeChatBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    var webView: WKWebView!
    let injectScript: String  // Contents of wechat-bro.js

    func setup() {
        let config = WKWebViewConfiguration()

        // 1. Register native event handler
        config.userContentController.add(self, name: "wechatEvent")

        // 2. Define the event bridge BEFORE page loads (via user script)
        let bridgeScript = WKUserScript(source: """
            window.sendToPuppeteer = function(event, data) {
                window.webkit.messageHandlers.wechatEvent.postMessage({
                    event: event,
                    data: data
                });
            };
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        config.userContentController.addUserScript(bridgeScript)

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.load(URLRequest(url: URL(string: "https://wx.qq.com")!))
    }

    // 3. Inject after Angular is ready
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        waitForAngularAndInject()
    }

    func waitForAngularAndInject() {
        webView.evaluateJavaScript("""
            (typeof angular !== 'undefined' && angular.element(document).injector()) ? true : false
        """) { result, _ in
            if result as? Bool == true {
                self.inject()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    self.waitForAngularAndInject()
                }
            }
        }
    }

    func inject() {
        webView.evaluateJavaScript(injectScript) { _, _ in
            self.webView.evaluateJavaScript("WechatyBro.init()")
        }
    }

    // 4. Receive events
    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let event = body["event"] as? String else { return }
        let data = body["data"]

        switch event {
        case "scan":
            // Show QR code
            if let d = data as? [String: Any], let url = d["loginUrl"] as? String {
                print("Scan: \(url)")
            }
        case "login":
            print("Logged in")
        case "contacts-ready":
            print("Contacts loaded")
        case "message":
            if let d = data as? [String: Any], let content = d["Content"] as? String {
                print("Message: \(content)")
            }
        case "logout":
            print("Logged out")
            // Re-inject on next page load
        default:
            break
        }
    }
}
```

#### Calling API Methods

Since there's no `page.evaluate` in WKWebView, wrap API calls in `evaluateJavaScript`:

```swift
// Send text message
func sendText(to: String, content: String) {
    let escaped = content.replacingOccurrences(of: "'", with: "\\'")
    webView.evaluateJavaScript("WechatyBro.send('\(to)', '\(escaped)')")
}

// Get contact list (async)
func getContacts(completion: @escaping ([[String: Any]]) -> Void) {
    webView.evaluateJavaScript("JSON.stringify(WechatyBro.contactList())") { result, _ in
        guard let json = result as? String,
              let data = json.data(using: .utf8),
              let contacts = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        else { return completion([]) }
        completion(contacts)
    }
}

// Get a single contact
func getContact(id: String, completion: @escaping ([String: Any]?) -> Void) {
    webView.evaluateJavaScript("JSON.stringify(WechatyBro.getContact('\(id)'))") { result, _ in
        guard let json = result as? String,
              let data = json.data(using: .utf8),
              let contact = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return completion(nil) }
        completion(contact)
    }
}

// Get supported emoji list
func getEmojis(completion: @escaping ([String]) -> Void) {
    webView.evaluateJavaScript("JSON.stringify(WechatyBro.getSupportedEmojis())") { result, _ in
        guard let json = result as? String,
              let data = json.data(using: .utf8),
              let emojis = try? JSONSerialization.jsonObject(with: data) as? [String]
        else { return completion([]) }
        completion(emojis)
    }
}

// Get contact avatar
func getAvatar(id: String, completion: @escaping (String?) -> Void) {
    webView.evaluateJavaScript("""
        new Promise(function(resolve) {
            WechatyBro.getContactImage('\(id)', resolve);
        })
    """) { result, _ in
        completion(result as? String)
    }
}
```

#### Uploading Media from iOS

`src/upload.js` is Node.js-only. For iOS, get upload params from wechat-bro.js and upload natively:

```swift
func sendImage(to: String, imageData: Data, filename: String) {
    // 1. Get upload params from inject
    webView.evaluateJavaScript("JSON.stringify(WechatyBro.getUploadParams('\(to)'))") { result, _ in
        guard let json = result as? String,
              let data = json.data(using: .utf8),
              let params = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let uploadUrl = params["uploadUrl"] as? String,
              let baseRequest = params["baseRequest"] as? [String: Any]
        else { return }

        // 2. Build multipart upload (MUST use IPv6 for file.wx.qq.com)
        let boundary = "----WKBoundary\(UUID().uuidString)"
        var body = Data()

        let fields: [(String, String)] = [
            ("id", "WU_FILE_0"),
            ("name", filename),
            ("type", "image/jpeg"),
            ("size", "\(imageData.count)"),
            ("mediatype", "pic"),
            ("uploadmediarequest", self.buildUploadRequest(baseRequest: baseRequest,
                params: params, fileSize: imageData.count)),
            ("webwx_data_ticket", params["webwxDataTicket"] as? String ?? ""),
            ("pass_ticket", params["passTicket"] as? String ?? ""),
        ]

        for (key, value) in fields {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(key)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }

        // File field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"filename\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(imageData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        // 3. Upload via URLSession
        var request = URLRequest(url: URL(string: "\(uploadUrl)?f=json")!)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        URLSession.shared.dataTask(with: request) { data, _, _ in
            guard let data = data,
                  let resp = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let mediaId = resp["MediaId"] as? String, !mediaId.isEmpty
            else { return }

            // 4. Send the uploaded image
            DispatchQueue.main.async {
                self.webView.evaluateJavaScript(
                    "WechatyBro.sendImageWithMediaId('\(to)', '\(mediaId)')"
                )
            }
        }.resume()
    }
}

func buildUploadRequest(baseRequest: [String: Any], params: [String: Any], fileSize: Int) -> String {
    let req: [String: Any] = [
        "UploadType": 2,
        "BaseRequest": baseRequest,  // Already unwrapped — do NOT double-wrap
        "ClientMediaId": "\(Int(Date().timeIntervalSince1970 * 1000))",
        "TotalLen": fileSize,
        "StartPos": 0,
        "DataLen": fileSize,
        "MediaType": 4,
        "FromUserName": params["fromUserName"] as? String ?? "",
        "ToUserName": params["toUserName"] as? String ?? "",
        "FileMd5": "",
    ]
    let data = try! JSONSerialization.data(withJSONObject: req)
    return String(data: data, encoding: .utf8)!
}
```

> **Important**: `file.wx.qq.com` hangs on IPv4 connections. On iOS, `URLSession` typically handles IPv6 correctly via Happy Eyeballs. If uploads hang, force IPv6 by resolving `file.wx.qq.com` to its AAAA record first.

For **Appium** iOS testing with Safari:

```js
// Appium + WebDriverIO — poll-based event bridge
const INJECT = fs.readFileSync('./src/wechat-bro.js', 'utf-8')

await browser.url('https://wx.qq.com')
await browser.waitUntil(async () => {
  return browser.execute(() => typeof angular !== 'undefined' && !!angular.element(document).injector())
}, { timeout: 30000 })

await browser.execute(`
  window._wechatEvents = [];
  window.sendToPuppeteer = function(event, data) {
    window._wechatEvents.push({event: event, data: data, ts: Date.now()});
  };
`)
await browser.execute(INJECT)
await browser.execute(() => WechatyBro.init())

// Poll for events
const events = await browser.execute(() => window._wechatEvents.splice(0))
```

### Option 6: Connect to existing Chrome via CDP

```bash
# Start Chrome with remote debugging
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222

# Open wx.qq.com in that Chrome, then run:
node test-inject.js
```

## Events

| Event | Data | When |
|---|---|---|
| `scan` | `{code, url, loginUrl}` | QR code shown. `code`: 0=new, 408=waiting, 201=scanned, 200=confirmed |
| `login` | `{id, name, UserName, NickName, HeadImgUrl, Sex}` | User logged in. `id` is the stable PYQuanPin-based identifier |
| `contacts-ready` | `{total, personal, withPinyin, elapsedMs}` | Contact list fully loaded with PYQuanPin data |
| `message` | Full message object with `from`/`to` contacts | Any message received |
| `message:text` | Same | Text message (MsgType 1) |
| `message:image` | Same | Image (MsgType 3) |
| `message:voice` | Same + `voiceData` base64 | Voice memo (MsgType 34) — auto-downloaded |
| `message:video` | Same | Video (MsgType 43) |
| `message:emoticon` | Same | Custom sticker (MsgType 47) |
| `message:location` | Same | Location share (MsgType 48) |
| `message:app` | Same | App message / file transfer (MsgType 49) |
| `message:card` | Same | Contact card (MsgType 42) |
| `message:system` | Same | System message (MsgType 10000) |
| `message:recalled` | Same | Recalled message (MsgType 10002) |
| `logout` | Source string | User logged out |
| `heartbeat` | `"heartbeat@browser"` | Every ~30s while connected |

## API Reference

All methods are on `window.WechatyBro` (browser context, call via `page.evaluate`).

### Message Fields

All `message` and `message:*` events include:

| Field | Type | Description |
|---|---|---|
| `from` | Contact | Sender contact (for rooms: the room itself) |
| `to` | Contact | Recipient contact |
| `sender` | Contact / undefined | **Room only**: individual sender within the room |
| `mentions` | string[] / undefined | **Room only**: stable IDs of @mentioned contacts |
| `mentionMe` | boolean / undefined | **Room only**: `true` if the account owner was @mentioned |
| `Content` | string | Message text (cleaned — sender prefix stripped for room messages) |
| `MsgType` | number | WeChat message type (1=text, 3=image, ...) |
| `MsgId` | string | Unique message identifier |

**Room message example**:
```jsonl
{"event":"message","data":{
  "from":{"id":"mygroup","name":"Dev Team","isRoomContact":true},
  "sender":{"id":"alice","name":"Alice"},
  "Content":"@Me\u2005 check the PR",
  "mentions":["me"],
  "mentionMe":true,
  "MsgType":1
}}

**`getContact(id)`** — Get a contact by stable ID or UserName. `name` uses fallback: RemarkName → NickName → UserName, with HTML emoji stripped.
```js
const contact = await page.evaluate(() => WechatyBro.getContact('alice'))
// { id: 'alice', name: 'Alice', UserName: '@abc...', HeadImgUrl: '...', Sex: 2, isRoomContact: false }
```

**`contactList()`** — Get all contacts with stable IDs. Same name fallback chain.
```js
const contacts = await page.evaluate(() => WechatyBro.contactList())
// [{ id: 'alice', name: 'Alice', isRoomContact: false, ... }, ...]
```

**`getRoomMembers(roomId)`** — Get members of a group chat. Names are cleaned (emoji HTML converted to Unicode).
```js
const members = await page.evaluate(() => WechatyBro.getRoomMembers('mygroup'))
// [{ id: 'alice', name: 'Alice', NickName: 'Alice', RemarkName: 'A', DisplayName: '小A', UserName: '@...' }, ...]
```

**`getContactImage(id, callback)`** — Get contact avatar as base64 data URI.
```js
const avatar = await page.evaluate(id => new Promise(r => WechatyBro.getContactImage(id, r)), 'alice')
// "data:image/jpeg;base64,/9j/4AAQ..."
```

### Messaging

**`send(to, content, watermark?)`** — Send text message. Auto-converts markdown to Unicode styling. Pass `true` as 3rd arg to add invisible AI watermark.
```js
// Simple text
await page.evaluate(() => WechatyBro.send('alice', 'Hello!'))

// Markdown auto-styled (bold, italic, code, lists, headers, blockquotes)
await page.evaluate(() => WechatyBro.send('alice', '**Bold** and *italic* with `code`'))

// Numbered lists
await page.evaluate(() => WechatyBro.send('alice', '1. First\n2. Second\n3. Third'))
// Renders: ① First  ② Second  ③ Third

// With AI watermark (invisible but detectable)
await page.evaluate(() => WechatyBro.send('alice', '## Report\n- Item 1\n- Item 2', true))

// With emoji
await page.evaluate(() => WechatyBro.send('alice', 'Hello! [Smile][Rose]'))

// With @mention in a room
await page.evaluate(() => {
  WechatyBro.send('mygroup', WechatyBro.at('alice', 'mygroup') + 'check this out!')
})
```

**`at(userId, roomId?)`** — Build an @mention string. Uses DisplayName (room alias) if set, otherwise the contact's NickName. Emoji in names are converted from HTML to Unicode. Returns `"@Name\u2005"` (thin space delimiter).
```js
// Use in room messages
await page.evaluate(() => {
  var msg = WechatyBro.at('alice', 'mygroup') + WechatyBro.at('bob', 'mygroup') + 'meeting at 3pm'
  WechatyBro.send('mygroup', msg)
})
// Sends: "@Alice @Bob meeting at 3pm"
```

**`getSupportedEmojis()`** — Get list of 209 supported emoji codes.
```js
const emojis = await page.evaluate(() => WechatyBro.getSupportedEmojis())
// ['[微笑]', '[撇嘴]', '[色]', ..., '[Smile]', '[Grimace]', ...]
```

**`downloadVoice(msgId, callback)`** — Download a voice message as base64.
```js
const voice = await page.evaluate(id => new Promise(r => WechatyBro.downloadVoice(id, r)), msgId)
```

**`isFromAI(msgOrContent)`** — Check if text content was sent by AI (has hidden watermark).
```js
const isAI = await page.evaluate((text) => WechatyBro.isFromAI(text), someContent)
```

**AI message suppression**: Messages sent via `send()`, `sendImageWithMediaId()`, or `sendFileWithMediaId()` are automatically suppressed from incoming message events — you won't receive your own AI-sent messages back. Detection uses:
- **MsgId tracking** (all types): `_sentMsgIds` tracks MsgIds in-memory for up to 1 hour (primary defense)
- **Zero-width watermark** (text only): `\u200B\u200C\u200B\u200C` prepended when `watermark=true`. `isFromAI()` detects it — fallback that works even across sessions

**Cross-login replay suppression**: Every time you log into WeChat Web, the server replays recent history messages. These are automatically suppressed using a **CreateTime high-water mark**:
- `wechat-bro.js` stores the highest `data.CreateTime` seen in a `wx_last_msg_time` cookie on `wx.qq.com`
- The CLI (`src/cli.js`) saves/loads this cookie transparently alongside other cookies — no special logic needed
- On next login, `wechat-bro.js` reads the cookie, and any message with `CreateTime ≤ lastMsgTime` is silently dropped
- The cookie survives process restarts (saved to `~/.wechat-bro/cookies.json` via `page.cookies()` / `page.setCookie()`)
- Same-session dedup (duplicate Angular events) still uses `_seenMsgIds` (MsgId-based, 2h TTL, max 2000 entries)

### Testing

**`simulateMessage(from, content, sender?, msgType?)`** — Simulate an incoming message for testing. Emits directly (bypasses Angular — safe for use alongside real WeChat). Accepts stable IDs.
```js
// Direct message
await page.evaluate(() => WechatyBro.simulateMessage('alice', 'hello'))

// Room message with sender
await page.evaluate(() => WechatyBro.simulateMessage('mygroup', 'hey everyone', 'alice'))

// Room message with @mention
await page.evaluate(() => WechatyBro.simulateMessage(
  'mygroup', '@Me\u2005 check this', 'alice'
))
// Emits: { from: room, sender: alice, mentions: ['me'], mentionMe: true, Content: '@Me\u2005 check this' }
```

### Markdown Styling

`send()` auto-converts markdown to Unicode mathematical symbols:

```js
await page.evaluate(() => WechatyBro.send('filehelper', `# Report
**Bold** and *italic* with \`code\`.
- Bullet 1
- Bullet 2
> Blockquote
---
~~old~~ replaced with **new**`))
```

Supported: `**bold**`, `*italic*`, `***bold italic***`, `` `monospace` ``, `~~strikethrough~~`,
`# ## ###` headers, `- *` bullets, `1. 2. 3.` numbered lists (①②③), `> ` blockquotes, `---` rules, ` ``` ` code blocks.

### Media Upload (Node.js side)

```js
const { sendImage, sendFile } = require('./src/upload')
```

**`sendImage(page, to, buffer, filename)`** — Upload and send an image.
```js
await sendImage(page, 'alice', fs.readFileSync('photo.jpg'), 'photo.jpg')
```

**`sendFile(page, to, buffer, filename)`** — Upload and send a file.
```js
await sendFile(page, 'alice', fs.readFileSync('doc.pdf'), 'doc.pdf')
```

**`uploadMedia(page, to, buffer, filename)`** — Upload only, returns MediaId.
```js
const mediaId = await uploadMedia(page, 'alice', imgBuf, 'img.png')
// Then send manually:
await page.evaluate((to, id) => WechatyBro.sendImageWithMediaId(to, id), 'alice', mediaId)
```

### Low-Level Upload (for non-Node.js environments)

**`getUploadParams(to)`** — Get all parameters needed to upload media (browser-side).
```js
const params = await page.evaluate(() => WechatyBro.getUploadParams('alice'))
// {
//   uploadUrl: "https://file.wx.qq.com/cgi-bin/mmwebwx-bin/webwxuploadmedia",
//   baseRequest: { Uin, Sid, Skey, DeviceID },
//   passTicket: "...",
//   fromUserName: "@self...",
//   toUserName: "@target...",
//   webwxDataTicket: "...",
//   skey: "@crypt_..."
// }
```

Use these params to build the multipart upload request in any language. The upload endpoint requires IPv6 (`file.wx.qq.com` hangs on IPv4). The `uploadmediarequest` form field must contain a JSON object with `BaseRequest` at the top level (NOT double-wrapped).

**`sendImageWithMediaId(to, mediaId)`** — Send a pre-uploaded image (browser-side).

**`sendFileWithMediaId(to, mediaId, filename, fileSize)`** — Send a pre-uploaded file (browser-side).

### Contact Identification

Contacts are identified by a **stable PYQuanPin-based ID** that persists across login sessions (unlike `UserName` which changes every login).

The ID is derived from `RemarkPYQuanPin` (if set) or `PYQuanPin`, lowercased and sanitized. Collisions (rare, ~2%) get a `_2` suffix.

All methods (`send`, `getContact`, `sendImage`, etc.) accept either:
- Stable ID: `'alice'`, `'zhangsan'`
- Original UserName: `'@abc123...'`
- Special names: `'filehelper'`, `'weixin'`

## Auto-Reinject

The bridge automatically re-injects after page reloads (QR expiry, phone-initiated logout, etc.). When using Puppeteer/Playwright, set up a `framenavigated` listener:

```js
page.on('framenavigated', async (frame) => {
  if (frame !== page.mainFrame()) return
  if (!frame.url().includes('wx.qq.com')) return
  
  await page.waitForFunction(
    () => typeof angular !== 'undefined' && angular.element(document).injector(),
    { timeout: 15000 }
  )
  await page.evaluate(INJECT)
  await page.evaluate(() => WechatyBro.init())
})
```

## Testing

```bash
# All tests (headless, uses saved cookies if available)
node test/test-inject.js

# Show browser window during tests
node test/test-inject.js --headed

# Force QR re-login (ignores saved cookies)
node test/test-inject.js --first-login
```

## Technical Notes

- **IPv6 required for uploads**: `file.wx.qq.com` hangs on IPv4. The upload module uses `curl -6`.
- **BaseRequest format**: `accountFactory.getBaseRequest()` returns `{BaseRequest: {...}}`. Must unwrap before use in upload requests — double-wrapping causes the server to silently hang.
- **Cookie association login**: When cookies exist, WeChat shows a "Log in" button instead of QR. The bridge auto-clicks it.
- **QR expiry**: Causes a full page reload. Auto-reinject handles this transparently.
- **Contact readiness**: Uses `Object.defineProperty` trap on `contactFactory.contactChangeFlag` for reactive detection, with timer fallback.
