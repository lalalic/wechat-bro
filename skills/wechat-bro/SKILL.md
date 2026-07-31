---
name: wechat-bro
description: >-
  Interact with WeChat from an AI agent — send/receive messages, manage
  contacts, upload media, transcribe voice, and more. Uses a headless Chrome
  process that injects into wx.qq.com and communicates via stdin/stdout JSON.
---

# wechat-bro — WeChat Agent Skill

## Overview

**wechat-bro** is a WebSocket + stdin JSON‑line process that lets AI agents
interact with WeChat Web.  It launches a headless Chrome, logs into
[wx.qq.com](https://wx.qq.com), and keeps a persistent session.  Multiple
agents can connect simultaneously via WebSocket.

```asciiart
                    ┌──────────────────┐
 Agent A ──ws──────→│                  │
 Agent B ──ws──────→│  wechat-bro-cli  │──→ wx.qq.com
 Agent C ──ws──────→│  (long‑lived)    │──→ Chrome
                    └──────────────────┘
                           │
                           ▼ stdout (events + backward compat stdin)
```

## Identity Model

Identify every contact by its **`name`** — the name you'd use to address them
(e.g. `李诚`, `Alice`, `Dev Team`). The account owner is always `"me"`.

The exact `name` string returned by any command can be reused as-is in the next
command's `to` field — no transformation needed.

**System accounts**: `filehelper` (File Transfer Helper) is available by its
canonical name `filehelper` **or** its localized name `文件传输助手` — both
resolve to the same chat.

**Ambiguity is an error.** If a name matches more than one contact (or none),
`send-text` / `send-image` / `send-file` / `room-members` / `get-contact` return an
error instead of guessing — surface it to the user to disambiguate:

```json
→ {"cmd":"send-text","to":"李诚","content":"hi"}
← {"ok":false,"error":"name \"李诚\" matches 2 contacts; please disambiguate (e.g. set a unique remark name with setRemark)"}
```

### @mentions in rooms

Use the **`@"<name>"`** format (double-quoted) anywhere in `send-text` content to
mention someone. The quoted name must match a member of the target room.

```json
→ {"cmd":"send-text","to":"Dev Team","content":"@\"Alice Chen\" check this"}
```

Incoming room messages arrive with the same `@"<name>"` form in `Content`, and
the resolved names are also listed in the message's `mentions` array. Unquoted
`@name` is treated as literal text, not a mention.

A stranger in a room (not your contact) can be @mentioned but not DM'd.

## Quick Start

```bash
npx wechat-bro --help

# Connect from an agent (WebSocket):
ws://localhost:9231
```

The process stays alive until it receives `{"cmd":"exit"}`.

## WebSocket Protocol

Connect to `ws://localhost:9231`.  Send/receive JSON messages.

### Agent → Server (request)

```json
{"cmd":"auth","agent":"testneo"}   # optional identification
{"cmd":"contacts","id":"req-1"}    # any command
{"cmd":"ping"}                     # liveness check
```

| field | required | description |
|---|---|---|
| `cmd` | yes | Command name (see below) |
| `id` | no | Opaque string echoed in response for correlation |

### Server → Agent (response)

```json
{"ok":true,"id":"req-1","data":[...]}
```

| field | description |
|---|---|
| `ok` | `true` on success, `false` on error |
| `id` | Echo of the request `id` (or null) |
| `data` | Command result |
| `error` | Error message (when `ok` is false) |

### Server → Agent (events — broadcast to all connected agents)

```json
{"event":"message","data":{...},"ts":<unix_ms>}
```

| event | when | data |
|---|---|---|
| `connected` | On connect | `{clientId, serverId}` |
| `ready` | After login + contacts loaded | `{loggedIn, contactsReady}` |
| `scan` | QR code displayed/updated | `{code, url, loginUrl, userAvatar?}`. `userAvatar` (when present, code 201) is a **file path** to the downloaded avatar at `~/.wechat-bro/userAvatar.png` |
| `login` | User logged in | `{name, …}` (self; `name` is `"me"`) |
| `logout` | User logged out | source string |
| `contacts-ready` | Contact list fully loaded (count stabilized) | `{total, elapsedMs}` |
| `message:text` | Incoming text message | Full message object with `from`/`to` |
| `message:image` | Incoming image | Same + `imageFile` (path to downloaded image in `~/.wechat-bro/download/`) |
| `message:voice` | Incoming voice memo | Same + `voiceFile` (path to audio) + `voiceText` (transcribed) |
| `message:*` | Other types | Same pattern |
| `heartbeat` | Every ~30s liveness check | `"heartbeat@browser"` |

### stdin mode

The process also accepts JSON commands on stdin (one per line) for pipe mode:

```bash
echo '{"cmd":"contacts"}' | npx wechat-bro
```

## Commands

### `contacts`
List individual contacts (people, not group chats). Returns a **name list only** — use `get-contact` for details.
```json
→ {"cmd":"contacts"}
← {"ok":true,"data":["Alice","Bob","小A"]}
```

### `rooms`
List group chats (rooms). Returns a **name list only** — use `get-contact` or `room-members` for details.
```json
→ {"cmd":"rooms"}
← {"ok":true,"data":["Dev Team","Family","项目组"]}
```

### `room-members`
Get members of a room. Returns a **name list only**.
Arg: `id` (the room **name**) over WebSocket, or `--name` on the CLI.
```json
→ {"cmd":"room-members","id":"Dev Team"}
← {"ok":true,"data":["Alice","小A"]}
```
```bash
npx wechat-bro room-members --name "Dev Team"
```

### `get-contact`
Get details for a single **contact or room** (resolved by name).  Arg: `id` (the **name**) over WebSocket, or `--name` on the CLI.
Does NOT include the member list — use `room-members` for that.
```json
→ {"cmd":"get-contact","id":"Alice"}
← {"ok":true,"data":{"name":"Alice","isRoomContact":false,…}}
```
```bash
npx wechat-bro get-contact --name "Dev Team"
```

### `send-text`
Send a text message.  Args: `to` (name), `content`.
- `to` must match exactly one contact.
- `@"name"` mentions supported (see @mentions above).
- markdown formatting is auto‑converted (see Markdown Styling below).
- `````marpit``` blocks are rendered to **PDF** (`slides.pdf`) and `````mermaid`
  blocks to **PNG** (`diagram.png`) — WeChat can't display HTML.
```json
→ {"cmd":"send-text","to":"Dev Team","content":"@\"Alice\" check the **PR**"}
← {"ok":true,"data":{"sent":true,"to":"Dev Team"}}

→ {"cmd":"send-text","to":"filehelper","content":"Flow:\\n```mermaid\\ngraph TD\\n  A-->B\\n```"}
← {"ok":true,"data":{"sent":true,"to":"filehelper","files":[{"file":"diagram.png","type":"mermaid"}],"caption":"Flow:"}}
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

### `emojis`
List all supported emoji codes (~210).
```json
→ {"cmd":"emojis"}
← {"ok":true,"data":["[微笑]","[撇嘴]",…,"[Smile]","[Rose]",…]}
```

### `exit`
Shut down gracefully.
```json
→ {"cmd":"exit"}
← {"ok":true}
```

## Auto-Render: Marpit & Mermaid

When `send-text` content contains ````marpit` or `````mermaid` code blocks, the
CLI auto-renders each one and sends the results as files — `````marpit` →
**PDF** (`slides.pdf`), `````mermaid` → **PNG** (`diagram.png`).  Any text
before, between, or after blocks is also sent as a normal message (with
`@mention`).

**Multiple blocks** are supported — all ````marpit` and ````mermaid` blocks in
content are processed in order.  Tools run via `npx` (auto-downloaded if
missing).  Response includes a `files` array:

```json
← {"ok":true,"data":{"sent":true,"to":"filehelper","files":[
    {"file":"diagram.png","type":"mermaid"},
    {"file":"slides.pdf","type":"marpit"}
  ],"caption":"See attached."}}
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

## Agent Integration
Strongly recommended: 
* use the `wechat-orchestrator` agent to manage multiple contacts
* delegate contact conversations to `wechat-contact-maintainer` subagents.
* use wechat-bro stdin mode to send commands and receive command result in JSONL format.
* use wechat-bro WebSocket mode to monitor specified contacts message and send to llm then let llm follow up.

### wechat-orchestrator Agent
The `wechat-orchestrator` agent is responsible for:
- create `wechat-contact-maintainer` subagents for specified contact to delegate conversations.
  - make conversation rules, including general and contact-specific rules, and pass them to subagents.
  - provide context to subagents, including contact ID, name, message content, and whether it's a group chat.
  - persistent session and context across restarts, including contact list and subagent states.
- maintain a list of monitored contacts and their subagents. save the list to disk for persistence across restarts.
  - pi agent: use `pi-subagents` `chain` to maintain the list of subagents.
  - other agents(codex, claude, copilot): figure out yourself
- communicate to user via wechat `filehelper` contact
- constantly update general and specific rules for subagents based on user feedback.

#### general rules
- remind user to respond to contacts that subagents report on.
- ask contact subagent to provide its own conversation information, such as summary, context, and history, to help the orchestrator make better decisions.
- save user uploaded knowledge base to `~/.wechat-bro/contacts/<contact-id>/knowledge/` folder, including text, pdf, and other documents.


### wechat-contact-maintainer Agent
The `wechat-contact-maintainer` agent handles individual contact conversations. It receives context from the orchestrator and uses `wechat-bro` to send replies. It is designed to maintain a natural and helpful conversation with the assigned contact, using their preferred language and style.

#### general rules
- **don't** provide any personal information about the user or the orchestrator agent.
- **make responses natural, friendly, grounding on the contact's message and context.**
- **if don't know the answer**, report to the wechat orchestrator agent.
- **use the contact's preferred language for replies.** default: 中文
- learn for the contact's preferences and style, and adapt responses accordingly.
- remember learnings from account owner's message
- save assets to own `~/.wechat-bro/contacts/<contact-id>/` folder
  - organize assets by type (images, audio, documents, etc.)
  - `knowledge/`: user uploaded knowledge base, including text, pdf, and other documents.