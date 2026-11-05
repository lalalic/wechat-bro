# wechat-bro

AI multi-agent interface for WeChat Web, using WebHelm-managed Chrome.

## Architecture

- WebHelm owns Chrome, the persistent profile, the WeChat Tab Group, and one leased Session.
- src/cdp.js uses the existing ws dependency to connect to the leased page over CDP.
- src/wechat-bro.js keeps the AngularJS message hooks and delivers events through Runtime.addBinding.
- src/cli.js preserves the existing WebSocket protocol on port 9231.
- src/orchestrator.js preserves contact-specific Agents, routing, memory and escalation.
- The Session heartbeats every 45 seconds and remains leased while the daemon runs. On exit, the dedicated WeChat Group and its Session leases are destroyed (other Groups remain intact).

There is no Puppeteer dependency, separate Chrome process, login-cookie export, or custom browser pool.

## Install

WebHelm is a required **external service**, not a Node dependency. Use a
separately installed WebHelm Runtime version 1.0.1 or newer; it owns the shared
Chrome, profile, Tab Groups and Session IPC. WeChat-bro never installs or starts
a second browser.

```bash
webhelm setup
npm install
webhelm status
npm run doctor       # or: wechat-bro doctor
```

The doctor verifies WebHelm Session IPC, Runtime version, and Chrome health;
wechat-bro also checks this at startup. Missing or outdated WebHelm returns
a clear webhelm_unavailable error with setup instructions. CDP endpoints are
obtained from WebHelm, never guessed from a fixed port. WEBHELM_SOCKET and
WEBHELM_RUNTIME_DIR may point to an existing test runtime, but
WEBHELM_CDP_ENDPOINT must match its managed Chrome.

## Quick start

```bash
wechat-bro --daemon     # start with managed WeChat tab, without signing in
wechat-bro --headed     # bring that tab forward when launching the daemon
wechat-bro barcode      # inspect current login QR only when requested
wechat-bro orchestrator --harness codex
```

Without an authenticated WeChat account, the daemon stays alive and commands
requiring login return login_required. It does not automatically open QR links or
attempt to sign in. After manual sign-in, the existing orchestrator takes over.

For custom clients, use the unchanged WebSocket interface:
`ws://localhost:9231`.

## Management inside WeChat Web

With the daemon running, open its managed WeChat tab in WebHelm. The
floating AI launcher at upper-right opens three settings tabs:

- Chats: select a contact/room, assign a routable Agent, set maintainer or
  assistant mode, watch/unwatch or pause/resume. Watch uses the existing
  Orchestrator and persists; Pause applies only until service restart.
- Agents: read and edit description/prompt Markdown. Bundled Agent files
  are never edited; Save creates an override. Routing and harness metadata
  use the established management workflow.
- Rules/Memory: edit global or contact-specific Markdown with explicit
  Load/Save and stale-write conflict protection.

The panel is injected through the daemon-owned CDP page and disappears when
the WeChat Group exits. No separate dashboard, WebHelm Extension or new
network port is installed. The local Node controller owns all file writes.
UI commands are allowlisted and require a per-page private nonce; administrative
buttons reject untrusted synthetic clicks.

The panel is available only on desktop WeChat Web. On an iPhone, manage
the bot by chatting with filehelper instead.

Test with npm test (offline) and npm run test:live:ui (real WebHelm Chrome
with mocked settings; no messages sent).

The Chats contact selector follows the highlighted WeChat conversation
automatically on panel open and on chat/title changes. It reads the active
WeChat UserName and contact display name rather than the surrounding header
which contains group member counts. A manually chosen contact is preserved
until the highlighted chat changes. Test with npm run test:live:active-chat
in an isolated Chrome tab without sending messages.

The six dropdowns use a compact, keyboard-accessible Shadow DOM listbox
instead of the native macOS select popup. This keeps option fonts, menu width,
and positioning consistent even when Chrome renders native menus at a different
scale. Run npm run test:live:select to test all six with real Chrome pointer
events in a disposable about:blank tab (without touching the active WeChat
session).

## Agent management through WeChat

Use filehelper in the WeChat Web UI to list Agents, inspect and edit their
Markdown definitions, configure watched contacts, switch modes, set rules and
memory, and resolve escalations. The orchestrator stores overrides under
`~/.wechat-bro/agents/` and reloads them on the next message. No separate
Agent management dashboard is required.

## Events

| Event | Data | When |
|---|---|---|
| `scan` | `{code, url, loginUrl}` | QR code shown. `code`: 0=new, 408=waiting, 201=scanned, 200=confirmed |
| `login` | `{name, NickName, HeadImgUrl, Sex}` | User logged in. `name` is `"me"` (the account owner's constant identity) |
| `contacts-ready` | `{total, elapsedMs}` | Contact list fully loaded (count stabilized across batches) |
| `message` | Full message object with `from`/`to` as **contact names** | Any message received |
| `message:text` | Same | Text message (MsgType 1) |
| `message:image` | Same + `imageFile` (file path) | Image (MsgType 3) — saved to the contact's `download/` folder |
| `message:voice` | Same + `voiceFile` (file path) + `voiceText` | Voice memo (MsgType 34) — audio saved to the contact's `download/` folder, transcribed |
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
| `from` | string | Sender contact **name** (for rooms: the room name) |
| `to` | string | Recipient contact **name** (usually `"me"` for incoming messages) |
| `sender` | string / undefined | **Room only**: name of the individual sender within the room |
| `mentions` | string[] / undefined | **Room only**: names of @mentioned contacts |
| `mentionMe` | boolean / undefined | **Room only**: `true` if the account owner was @mentioned |
| `Content` | string | Message text (cleaned — sender prefix stripped for room messages) |
| `MsgType` | number | WeChat message type (1=text, 3=image, ...) |
| `MsgId` | string | Unique message identifier |

**Room message example**:
```jsonl
{"event":"message","data":{
  "from":"Dev Team",
  "sender":"Alice",
  "Content":"@\"me\" check the PR",
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
// [{'name': 'Alice', 'isRoomContact': false, ...}, ...]  — name-only identity
```

**`getContactImage(name, callback)`** — Get contact avatar as base64 data URI.
```js
const avatar = await page.evaluate(n => new Promise(r => WechatyBro.getContactImage(n, r)), 'Alice')
// "data:image/jpeg;base64,/9j/4AAQ..."
```

### Messaging

**`send(to, content, watermark?)`** — Send text message. `to` is a contact **name** (or `"me"` / `"filehelper"` / `"文件传输助手"`). Auto-converts markdown to Unicode styling. Pass `true` as 3rd arg to add invisible AI watermark.
```js
// Simple text
await page.evaluate(() => WechatyBro.send('Alice', 'Hello!'))

// Markdown auto-styled (bold, italic, code, lists, headers, blockquotes)
await page.evaluate(() => WechatyBro.send('Alice', '**Bold** and *italic* with `code`'))

// Numbered lists
await page.evaluate(() => WechatyBro.send('Alice', '1. First\n2. Second\n3. Third'))
// Renders: ① First  ② Second  ③ Third

// With AI watermark (invisible but detectable)
await page.evaluate(() => WechatyBro.send('Alice', '## Report\n- Item 1\n- Item 2', true))

// With emoji
await page.evaluate(() => WechatyBro.send('Alice', 'Hello! [Smile][Rose]'))

// With @mention in a room — write @"<contactName>" (quoted, whitespace-safe);
// wechat-bro renders WeChat's @<alias>\u2005 internally.
await page.evaluate(() => {
  WechatyBro.send('Dev Team', '@"Alice Chen" check this out!')
})
```

**`at(userId, roomId?)`** — **Internal** helper that builds WeChat's wire-format `@<DisplayName>\u2005`. Agents should NOT call this directly — write `@"<name>"` in `send` content instead. Exposed only because `sendText` uses it during outgoing rewriting. Returns `"@Name\u2005"` (thin space delimiter).
```js
// DO NOT call at() directly from agent code. Prefer send() with @"name":
await page.evaluate(() => WechatyBro.send('Dev Team', '@"Alice Chen" @"Bob" meeting at 3pm'))
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
- On next login, `wechat-bro.js` reads the cookie, and any message with `CreateTime ≤ lastMsgTime` is silently dropped
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
const { sendImage, sendVideo, sendFile } = require('./src/upload')
```

**`sendImage(page, to, buffer, filename)`** — Upload and send an image.
```js
await sendImage(page, 'alice', fs.readFileSync('photo.jpg'), 'photo.jpg')
```

**`sendVideo(page, to, buffer, filename)`** — Upload and send a native video message.
```js
await sendVideo(page, 'alice', fs.readFileSync('clip.mp4'), 'clip.mp4')
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

**`sendVideoWithMediaId(to, mediaId)`** — Send a pre-uploaded native video message (browser-side).

**`sendFileWithMediaId(to, mediaId, filename, fileSize)`** — Send a pre-uploaded file (browser-side).

### Contact Identification

**Outside wechat-bro, contacts are identified by `name` only.** The `name` is the
contact's display name (`RemarkName`/`NickName` — what users actually call them),
normalized by `cleanName` (emoji HTML → Unicode, tags stripped). The account
owner always has the constant name `"me"`. WeChat's internal `@hash UserName` and
any romanized ids are never exposed to callers.

All methods (`send`, `getContact`, `sendImage`, etc.) accept a contact **name**:
- Display name: `'Alice'`, `'李诚'`, `'Dev Team'`
- Self: `'me'`
- System accounts: `'filehelper'`, `'weixin'`

**Ambiguity is an error.** If a name matches more than one contact, actions
(`send`, `send-image`, …) return an error instead of guessing. Room members are
also addressed by contact name (their room-specific alias is handled internally);
a stranger in a room has no contact name and can only be @mentioned, not DM'd.

## Auto-Reinject

The daemon detects WeChat navigation through CDP and re-injects AngularJS
hooks once the page is ready. Runtime.addBinding survives new document loads.
A missing login is reported as login_required without starting an unsolicited
login flow.

## Testing

- npm test: offline protocol, routing, media and STT regression suites
- WEBHELM_E2E=1 node test/test-cdp.js: real managed Chrome Session/CDP tests, no login
- npm run test:live: integration test using manually authenticated WeChat
- npm run test:live:exit: real daemon exit/restart/SIGTERM Group destruction tests (no messages sent)

The WeChat Group holds one long-lived Session and is destroyed on daemon exit; do not run live browser tests
while the production daemon holds that group lease. Real account tests must
restrict outgoing contacts explicitly.

## Technical Notes

- Media uploads use curl -6 because file.wx.qq.com can require IPv6.
- accountFactory.getBaseRequest() returns a wrapped BaseRequest property.
- WebHelm manages the persistent Chrome profile and all authentication cookies.
- QR expiry/reload triggers controlled CDP reinjection.
- Contact readiness uses AngularJS events and a timer fallback.
