# wechat-bro

AI multi-agent interface for WeChat Web, using WebHelm-managed Chrome.

## Architecture

- WebHelm owns Chrome, the persistent profile, the WeChat Tab Group, and one leased Session.
- src/cdp.js uses the existing ws dependency to connect to the leased page over CDP.
- src/wechat-bro.js keeps the AngularJS message hooks and delivers events through Runtime.addBinding.
- src/cli.js preserves the existing WebSocket protocol on port 9231.
- src/orchestrator.js preserves contact-specific Agents, routing, memory and escalation.
- The Session heartbeats every 45 seconds and remains leased while the daemon runs.

There is no Puppeteer dependency, separate Chrome process, login-cookie export, or custom browser pool.

## Install

Install WebHelm first and prepare its managed Chrome. Then install wechat-bro.

```bash
webhelm setup
npm install
webhelm status
```

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
- WebHelm manages the browser profile and retains this replay cookie across daemon restarts
- On next login, `wechat-bro.js` reads the cookie, and any message with `CreateTime ≤ lastMsgTime` is silently dropped
- Same-session dedup (duplicate Angular events) still uses `_seenMsgIds` (MsgId-based, 2h TTL, max 2000 entries)

### Testing

```bash
npm test
WEBHELM_E2E=1 node test/test-cdp.js
npm run test:live
```

The offline tests do not need WeChat login. The WebHelm CDP test uses a
temporary owned Session and sends no messages. The account integration suite
requires manual login. Do not run live Session tests while the long-lived
WeChat daemon already owns the single Tab Group lease.

## Technical Notes

- **IPv6 required for uploads**: `file.wx.qq.com` hangs on IPv4. The upload module uses `curl -6`.
- **BaseRequest format**: `accountFactory.getBaseRequest()` returns `{BaseRequest: {...}}`. Must unwrap before use in upload requests — double-wrapping causes the server to silently hang.
- **Cookie association login**: When cookies exist, WeChat shows a "Log in" button instead of QR. The bridge auto-clicks it.
- **QR expiry**: Causes a full page reload. Auto-reinject handles this transparently.
- **Contact readiness**: Uses `Object.defineProperty` trap on `contactFactory.contactChangeFlag` for reactive detection, with timer fallback.
