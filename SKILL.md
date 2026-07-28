---
name: wechat-bro
description: >-
  Interact with WeChat from an AI agent — send/receive messages, manage
  contacts, upload media, transcribe voice, and more. Uses a headless Chrome
  process that injects into wx.qq.com and communicates via stdin/stdout JSON.
---

# wechat-bro — WeChat Agent Skill

## Overview

**wechat-bro** is a stdin/stdout JSON‑line process that lets an AI agent
interact with WeChat Web.  It launches a headless Chrome, logs into
[wx.qq.com](https://wx.qq.com), and keeps a persistent session.  The agent
sends JSON commands on **stdin** and reads JSON responses + streaming events
from **stdout**.

```
┌──────────────┐   stdin (JSON)    ┌──────────────────┐
│   AI Agent   │ ───────────────→  │  wechat-bro-cli  │──→ wx.qq.com
│  (Copilot…)  │ ←───────────────  │  (long‑lived)    │──→ Chrome
└──────────────┘   stdout (JSON)   └──────────────────┘
```

## Quick Start

```bash
# Install from npm (or use via npx):
npm install -g wechat-bro

# First run (will show QR code for login):
echo '{"cmd":"status"}' | wechat-bro --headed

# Or via npx without installing:
echo '{"cmd":"status"}' | npx wechat-bro --headed

# Subsequent runs reuse saved cookies — headless works:
echo '{"cmd":"contacts"}' | wechat-bro
```

Once running, the process stays alive until stdin closes or it receives
`{"cmd":"exit"}`.  Events stream continuously to stdout.

## Protocol

### Request format (stdin)

One JSON object per line:
```json
{"cmd":"contacts","id":"req-1"}
```

| field | required | description |
|---|---|---|
| `cmd` | yes | Command name (see below) |
| `id` | no | Opaque string echoed in response for correlation |

### Response format (stdout)

```json
{"ok":true,"id":"req-1","data":[...]}
```

| field | description |
|---|---|
| `ok` | `true` on success, `false` on error |
| `id` | Echo of the request `id` (or null) |
| `data` | Command result |
| `error` | Error message (when `ok` is false) |

### Streaming events

Interleaved with responses.  Every event has the shape:
```json
{"event":"<type>","data":{...},"ts":<unix_ms>}
```

| event | when | data |
|---|---|---|
| `ready` | After login + contacts loaded | `{loggedIn, contactsReady}` |
| `scan` | QR code displayed/updated | `{code, url, loginUrl, userAvatar?}` |
| `login` | User logged in | `{id, name, UserName, …}` |
| `logout` | User logged out | source string |
| `contacts-ready` | Contact list fully loaded | `{total, withPinyin, elapsedMs}` |
| `message` | Any incoming message | Full message object with `from`/`to` |
| `message:text` | Incoming text message | Same as `message` |
| `message:image` | Incoming image | Same + `imageBase64` (auto‑downloaded) |
| `message:voice` | Incoming voice memo | Same + `voiceBase64` + `voiceText` (transcribed) |
| `message:*` | Other types | Same pattern |
| `heartbeat` | Every ~30s liveness check | `"heartbeat@browser"` |

## Commands

### `contacts`
List all contacts.
```json
→ {"cmd":"contacts"}
← {"ok":true,"data":[
    {"id":"alice","name":"Alice","UserName":"@…","isRoomContact":false,"memberCount":0},
    {"id":"mygroup","name":"Dev Team","UserName":"@@…","isRoomContact":true,"memberCount":12}
  ]}
```

### `rooms`
List only group chats.
```json
→ {"cmd":"rooms"}
← {"ok":true,"data":[
    {"id":"mygroup","name":"Dev Team","UserName":"@@…","memberCount":12}
  ]}
```

### `room-members`
Get members of a room.  Arg: `id` (room UserName or pyId).
```json
→ {"cmd":"room-members","id":"@@roomhash"}
← {"ok":true,"data":[
    {"id":"alice","name":"Alice","UserName":"@…","NickName":"Alice","DisplayName":"小A"}
  ]}
```

### `get-contact`
Get single contact details.  Arg: `id`.
```json
→ {"cmd":"get-contact","id":"alice"}
← {"ok":true,"data":{"id":"alice","name":"Alice","UserName":"@…","isRoomContact":false,…}}
```

### `send`
Send a text message (always watermarked).  Args: `to`, `content`.
- `@contactid` supported
- markdown formatting is auto‑converted to Unicode bold/italic/mono (see below).
```json
→ {"cmd":"send","to":"testneo","content":"@alice check the **PR**"}
← {"ok":true,"data":{"sent":true,"to":"testneo"}}
```

### `send-image`
Send an image.  Uploads from local disk to WeChat CDN, then sends.
Args: `to`, `path` (local file), `filename?` (defaults to basename of path).
```json
→ {"cmd":"send-image","to":"filehelper","path":"/tmp/photo.jpg"}
← {"ok":true,"data":{"sent":true,"to":"filehelper","file":"photo.jpg"}}
```

### `send-file`
Send an arbitrary file (PDF, ZIP, etc.).  Args: `to`, `path`, `filename`.
```json
→ {"cmd":"send-file","to":"filehelper","path":"/tmp/report.pdf","filename":"report.pdf"}
← {"ok":true,"data":{"sent":true,"to":"filehelper","file":"report.pdf"}}
```

### `send-voice`
Transcribe a local audio file via Whisper STT and send the text as a message.
Args: `to`, `path`.
```json
→ {"cmd":"send-voice","to":"filehelper","path":"/tmp/voice.mp3"}
← {"ok":true,"data":{"sent":true,"to":"filehelper","transcription":"你好，这是一条语音消息"}}
```

### `status`
Get current login/contacts state.
```json
→ {"cmd":"status"}
← {"ok":true,"data":{"loggedIn":true,"contactsReady":true,"lastMsgTime":1785200000,"initState":true}}
```

### `supported-emojis`
List all supported emoji codes (~210).
```json
→ {"cmd":"supported-emojis"}
← {"ok":true,"data":["[微笑]","[撇嘴]",…,"[Smile]","[Rose]",…]}
```

### `exit`
Shut down gracefully.
```json
→ {"cmd":"exit"}
← {"ok":true}
```

## Markdown Styling

`send()` auto‑converts markdown to Unicode mathematical bold/italic/mono:

| Markdown | Rendered |
|---|---|
| `**bold**` | **𝗯𝗼𝗹𝗱** (mathematical bold) |
| `*italic*` | *𝘪𝘵𝘢𝘭𝘪𝘤* (mathematical italic) |
| `` `code` `` | `𝚌𝚘𝚍𝚎` (mathematical monospace) |
| `~~strike~~` | s̶t̶r̶i̶k̶e̶ (combining strikethrough) |
| `- item` | • item (bullet) |
| `1. item` | ① item (circled number) |
| `# Heading` | **Heading** + separator |
| `> quote` | ❙ quote (blockquote) |

## Agent Integration: Watching messages.jsonl

LLM agent frameworks work in a **request/response tool loop**.  Polling or
blocking for messages wastes tokens or blocks the agent.  Instead, wechat-bro
appends incoming message events to a **JSONL file** that an external agent can
watch independently.

### Data directory

All persistent data lives under `~/.wechat-bro/`:

| File | Purpose |
|---|---|
| `cookies.json` | Saved login session (auto-loaded on restart) |
| `messages.jsonl` | Incoming message events, one JSON line per event |

### Watching for new messages

External agents (Copilot extensions, Claude MCP servers, pi pipeline steps)
can **tail `~/.wechat-bro/messages.jsonl`** or watch for changes using
`fs.watch` / `inotify` / `fswatch`.

```bash
# Simple tail (last ~10 lines)
tail -n 10 ~/.wechat-bro/messages.jsonl

# Continuous follow (new messages as they arrive)
tail -f ~/.wechat-bro/messages.jsonl | while read line; do
  echo "New message: $line"
  # inject into agent conversation...
done
```

The JSONL file contains only **message events** (`message`, `message:text`,
`message:image`, `message:voice`, etc.) — one per line.  Heartbeats and
other system events are not written to the file (they still stream to stdout).

Each line:
```json
{"event":"message:text","data":{"Content":"你好","from":"alice",…},"ts":…}
```

## Voice Transcription

Voice messages are automatically transcribed via Whisper STT:
```bash
uvx --from openai-whisper whisper <audio> --output_format=txt --language=zh
```
The transcribed text is attached as `voiceText` in the `message:voice` event.

## Contact Identification

Contacts have **stable PYQuanPin‑based IDs** that persist across login
sessions (unlike `UserName` which changes).  The ID is derived from
`RemarkPYQuanPin` or `PYQuanPin`, lowercased.

All methods accept either a stable ID (`alice`), a UserName (`@abc…`), or
a special name (`filehelper`, `weixin`).

## Media Upload

Files are uploaded via `curl -6` to `file.wx.qq.com` (requires IPv6).
Use the `send-image` and `send-file` commands, or the
`src/upload.js` module directly.

