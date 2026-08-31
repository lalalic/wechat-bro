---
name: wechat-bro
description: Interact with WeChat from an AI agent — send/receive messages, manage contacts, upload media, transcribe voice, and more.
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
(e.g. `李三`, `Alice`, `Dev Team`). The account owner is always `"me"`.

The exact `name` string returned by any command can be reused as-is in the next
command's `to` field — no transformation needed.

**System accounts**: `filehelper` (File Transfer Helper) is available by its
canonical name `filehelper` **or** its localized name `文件传输助手` — both
resolve to the same chat.

**Ambiguity is an error.** If a name matches more than one contact (or none),
`send-text` / `send-image` / `send-file` / `room-members` / `get-contact` return an
error instead of guessing — surface it to the user to disambiguate:

```json
→ {"cmd":"send-text","to":"李三","content":"hi"}
← {"ok":false,"error":"name \"李三\" matches 2 contacts; please disambiguate (e.g. set a unique remark name with setRemark)"}
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
| `contacts-ready` | Contact list loaded (count stabilized) | `{total, elapsedMs}` |
| `message:text` | Incoming text message | Message object with `from`/`to` as **contact names** (strings; `"me"` for self; `sender` for room messages). Raw field `Content` holds the text |
| `message:*` (non-text) | Incoming image/voice/video/emoticon/location/card/verify/status | **Simplified object**: `content` is the useful representation per type (see below). All raw wire-format fields (XML `Content`, `RecommendInfo`, `MMActual*`, …) and every empty field (`null`/`""`/`[]`) are stripped; kept fields: `MsgId`, `from`, `to`, `sender`, `mentions`, `mentionMe`, `ts`, `type`, `content` + type extras |

**Suppressed types — no event is emitted**: `app` (49, incl. file attachments & shared articles), `system` (10000), `recalled` (10002). These are XML wire noise; agents never receive them.

Non-text `content` per type:

Downloaded media lands in the chat contact's own folder:
`~/.wechat-bro/contacts/<contact name>/download/<filename>_<MsgId>.<ext>`
(the contact is the chat the message belongs to — for room messages that's
the room's folder).

| type | `content` | extras |
|---|---|---|
| `image` | path to downloaded image | |
| `voice` | transcribed text (Whisper), falling back to the audio file path | `voiceFile` |
| `video` / `microvideo` | path to downloaded video (`.mp4`) | |
| `emoticon` | emoji CDN url | |
| `location` | `"label (poiname)"` | |
| `card` | `"[contact card: Name]"` | |
| `verify` / `status` | plain readable text | |
| `heartbeat` | Every ~30s liveness check | `"heartbeat@browser"` |

### stdin mode

The process also accepts JSON commands on stdin (one per line) for pipe mode:

```bash
echo npx wechat-bro
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

`send-text` content supports markdown:

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

One **`wechat-orchestrator`** manages the whole WeChat account. It talks to the
account user via **`filehelper`**, listens to message events for a configured
**watch list** of contacts, and dispatches each conversation to that contact's
own agent task. The spec below is harness-agnostic — pi, codex, claude code,
copilot … each implement it with their own primitives (see Harness Mapping).

```
contact msg ──ws──▶ orchestrator ──watched?──▶ contact agent task ──send-text──▶ contact
                      ▲                            │ can't answer?
                      └──── filehelper ◀── escalate / report ──────────────────────┘
user msg ──filehelper──▶ orchestrator: guidance → update rules & memories
```

### On-disk layout

```
~/.wechat-bro/
├── contacts.json            # orchestrator state: watch list, per-contact agent choice
├── memory.md                # shared memory — read by every agent, updated by orchestrator
├── rules.md                 # general conversation rules (shared)
└── contacts/<contact>/      # per-contact root (a person or a room name)
    ├── session/             # dedicated session — all conversation history for this contact
    ├── memory.md            # dedicated memory (contact's preferences & learnings)
    ├── rules.md             # contact-specific rules
    ├── knowledge/           # user-uploaded knowledge base (text, pdf, …)
    └── download/            # incoming media (written automatically by wechat-bro)
```

### wechat-orchestrator

- **User channel**: talk to the account user only via `filehelper` — reports, questions, escalations.
- **Inbound**: hold one WebSocket on `ws://localhost:9231`; drop `message:text` / `message:*` events whose `from` is not on the watch list; persist the watch list in `contacts.json` so restarts recover.
- **Dispatch**: for each incoming message, wake the contact's agent with contact name, message content, room `sender`/`mentions` when it's a room, and the paths to its `session/`, `memory.md`, `rules.md`, `knowledge/` plus the shared `memory.md` / `rules.md`.
- **Sessions**: one dedicated session per contact — resume it instead of starting over; never mix two contacts into one session.
- **Feedback loop**: guidance arriving via `filehelper` updates shared or contact rules/memories; when a contact agent escalates, relay it to the user.

### contact agents — common or customized

Agent definitions are plain **markdown files in `~/.wechat-bro/agents/`**:

```
~/.wechat-bro/agents/
├── wechat-individual-maintainer.md   # common: person DMs — DM etiquette, no noise, private-context answers
├── wechat-room-maintainer.md         # common: group chats — reply only when relevant or mentionMe, address via @"name"
└── wechat-<contact>.md               # customized: overrides the matching default for that one contact
```

An agent md takes effect **only when the orchestrator injects it at dispatch** —
no harness auto-loads it. Selection per contact: `wechat-<contact>.md` if it
exists, else the room/individual default by `isRoomContact`. Injection options:

- pass its contents as the system prompt of the dispatched task (pi: `--append-system-prompt "$(cat ~/.wechat-bro/agents/<chosen>.md)"`)
- or symlink/copy it to `AGENTS.md` inside the contact's root folder — harnesses with cwd context-file discovery (pi, claude code) then load it automatically because dispatch sets cwd to the contact root.

Rules for both:

- **don't** reveal personal information about the user or the orchestrator.
- reply natural & friendly, grounded in the contact's message, session history and memories; use the contact's language (default: 中文).
- **can't answer or sensitive** → escalate to the orchestrator instead of guessing.
- persist learnings into the contact's dedicated `memory.md`; the shared `memory.md` carries account-wide facts (user preferences, style).
- save assets into the contact's own root folder, organized by type; knowledge base into `knowledge/`.

### Bootstrap: `wechat-bro orchestrator`

The orchestrator ships as a command — no glue code needed:

```bash
npx wechat-bro orchestrator   # daemon must be running (wechat-bro --daemon)
```

It connects to the daemon as a WebSocket client and loads `*.agent.md` files
from the **skill's own `agents/` dir** (shipped inside the installed package —
works with zero setup). `~/.wechat-bro/agents/` is an optional user overlay
(wins by `name`); nothing is seeded there. Agent mds are reloaded on every
incoming message, so edits apply immediately. Flags: `--agents-dir <dir>`
(additional overlay), `--harness <cmd-template>` (override every agent's
harness), `--port <port>`.

Agent md frontmatter configures each task (body = agent system prompt):

```markdown
---
name: wechat-alice            # required, unique
description: ...
contacts: [Alice]             # dedicated routing — exact contact names (maintainer mode, default)
contacts-assistant: [Bob]     # dedicated routing in ASSISTANT mode — AI answers ping-style
type: contact                 # contact | room | orchestrator (fallback class)
harness: pi                   # pi (built-in) or shell template with {task}
provider: anthropic           # optional → pi --provider
model: sonnet                 # optional → pi --model
thinking: off                 # default off; off|minimal|low|…|max
skills: false                 # default off → pi --no-skills; true = allow skill discovery
session-id: wechat-alice      # default: wechat-<sanitized contact>
session-dir: ~/.wechat-bro/contacts/Alice/session
cwd: ~/.wechat-bro/contacts/Alice
timeout: 900                  # seconds
notify: true                  # completion summary → filehelper
---
Alice-specific instructions…
```

The `type: orchestrator` agent has FIXED paths — `cwd` = `~/.wechat-bro`,
`session-id` = `wechat-orchestrator`, `session-dir` = `~/.wechat-bro/session`
(not configurable via frontmatter).

Routing: `me → filehelper` messages go to the `type: orchestrator` agent in
**assistant mode** (always answered, replies prefixed 🤖); contact messages
match a dedicated `contacts-assistant:` agent first, then a dedicated
`contacts:` agent, then the unrestricted `type: contact` / `type: room`
default. Watch list = union of all `contacts:` + `contacts-assistant:`. Per contact, dispatch writes the message to a task file, symlinks
the chosen agent md as `AGENTS.md` in the contact's root (the harness cwd),
and runs the harness headless with a resumable session
(`pi -p --session-dir <dir> --session-id <id> --thinking off @task.md`). A
task is never run concurrently with itself; failures are reported to
`filehelper`.

### Modes

Two modes, **mutually exclusive per task** (one dispatch = one mode), with
deliberately opposite business goals:

- **Maintainer** (default for all contacts): **hide AI from the counterpart**
  — converse as the account owner, never admit to being an assistant; deflect
  if asked, never confirm, never lie. Escalation replies from the owner are
  delivered in this mode too.
- **Assistant**: the sender explicitly talks to the AI (via `?!xxx` ping or a
  `contacts-assistant` configuration) or IS the owner (filehelper) — answer
  directly, admitting to be an AI is expected, replies prefixed 🤖.

**Per-contact mode configuration** — frontmatter decides the default per
contact:

- `contacts: [Alice]` → maintainer mode; a `?!` ping promotes just that
  message to assistant.
- `contacts-assistant: [Bob]` → assistant-managed: every message dispatches
  as assistant, but **only `?!` pings get replies** (open, 🤖); ordinary
  messages are **context-only** — recorded in the session, never answered
  (`{"status":"ignored"}`).
- `filehelper` → always assistant (never record-only). The orchestrator
  agent declares it via `contacts-assistant: [filehelper]`.

A contact declared in both lists resolves to assistant. To monitor a contact
with no dedicated agent md, just list it under `contacts:` in any agent md —
the type default (individual/room maintainer) handles it in maintainer mode.

### Task payload & skill loading

Tasks are **self-contained**: the agent md (symlinked `AGENTS.md`) inlines the
only wechat-bro command a task needs (`send-text` via stdin pipe) — tasks do
**not** load the full wechat-bro skill protocol. pi dispatches run with
`--no-skills` unless an agent opts in with `skills: true`.

### Task result contract

Every dispatched task must send its WeChat reply (if any) **before** it ends,
then terminate with exactly one JSON result line as the last line of its
output — the orchestrator parses it:

| result | meaning |
|---|---|
| `{"status":"addressed"}` | handled (replied, or deliberately silent per rules) |
| `{"status":"ignored"}` | no reply was needed |
| `{"status":"escalated","question":"…"}` | needs the account owner's decision |

Missing/malformed output degrades gracefully to `addressed`. On `escalated`,
the orchestrator reports to the owner via `filehelper` in a fixed format
(`🤖❓ 请示 — <contact> …`); the owner's next filehelper reply is routed back
into that contact's session — recorded in the contact's history, delivered to
the contact, and settleable into `rules.md`/`memory.md`.

### Harness mapping

Per-contact tasks run through **each harness's own CLI in headless mode** — one
invocation per message batch, session resumed each time, working directory set
to the contact's root folder so all relative reads/writes stay inside it:

| concept | pi | other harnesses |
|---|---|---|
| message listener | extension holding the WS client (reference: `@lalalic/channel`) | hook / small script on `ws://localhost:9231` |
| per-contact task | `pi -p --append-system-prompt "$(cat <agent-md>)" --session-dir <contact>/session --session <contact-id> "<msg + ctx>"` (or `<agent-md>` symlinked as `AGENTS.md` in contact root) | own CLI one-shot, e.g. `claude -p --agents`/`--resume <id>`, `codex exec resume` |
| dedicated session | `--session <contact-id>` + `--session-dir <contact>/session` | harness-native `--resume` / session id, one per contact |
| rules & memory | plain files under `~/.wechat-bro/` injected into the prompt | same files, same contract |

Dispatch contract (any harness): non-interactive one-shot mode, resumable
session stored under the contact's `session/`, cwd = contact root.