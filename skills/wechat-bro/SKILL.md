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
own agent task. The spec below is harness-agnostic — codex, claude code,
copilot … each implement it with their own primitives (see Harness).

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

- pass its contents as the system prompt of the dispatched task (`$(cat <agent-md>)` in your harness template)
- or let the orchestrator symlink it to `AGENTS.md` inside the contact's root folder — done automatically at dispatch, so harnesses with cwd context-file discovery (claude code, codex …) load it without any flag.

Rules for both:

- **don't** reveal personal information about the user or the orchestrator.
- reply natural & friendly, grounded in the contact's message, session history and memories; use the contact's language (default: 中文).
- **can't answer or sensitive** → escalate to the orchestrator instead of guessing.
- persist learnings into the contact's dedicated `memory.md`; the shared `memory.md` carries account-wide facts (user preferences, style).
- save assets into the contact's own root folder, organized by type; knowledge base into `knowledge/`.

### Bootstrap: `wechat-bro orchestrator`

The orchestrator ships as a command — no glue code needed:

```bash
npx wechat-bro orchestrator   # connects to the daemon, spawning one as a child if none runs
```

`wechat-bro up` starts daemon + orchestrator detached, idempotently — the
one command every start path uses. How it should start *in the future*
(service, session hook, manual) is a decision, not an accident — see
**Lifecycle & Startup Contract** at the end of this skill.

It connects to the daemon as a WebSocket client and loads `*.md` agent files
(legacy `.agent.md` still accepted) from **`~/.wechat-bro/agents/`** (the
only user dir), falling back to the skill's own bundled `agents/` for
anything not overridden — works with zero setup; nothing is seeded. Agent
files are reloaded on every incoming message, so edits apply immediately.
Flags: `--harness <tpl|name>` (override every agent's harness), `--port <port>`;
if no daemon is running the orchestrator spawns one as a **child process**
(it then lives and dies with the orchestrator), and `--daemon` forces that
even when a daemon already answers.

Agent md frontmatter configures each task (body = agent system prompt):

```markdown
---
name: wechat-alice            # required, unique
description: ...
contacts: [Alice]             # dedicated routing — exact contact names (maintainer mode, default)
contacts-assistant: [Bob]     # dedicated routing in ASSISTANT mode — AI answers ping-style
type: contact                 # contact | room | orchestrator (fallback class)
harness: pi                   # named harness (pi | claude | codex | copilot —
                              # default pi) or a custom shell template with
                              # {task} {session-id} {session-dir} {cwd}
                              # {contact} {name} {timeout} — every harness
                              # flag lives IN the template
session-id: wechat-alice      # default: wechat-<sanitized contact>
session-dir: ~/.wechat-bro/contacts/Alice/session
cwd: ~/.wechat-bro/contacts/Alice
timeout: 900                  # seconds
notify: true                  # concise note → filehelper at dispatch time,
                              # only when the message needs a response (never
                              # for context-only or the owner's own messages)
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
default. Watch list = union of all `contacts:` + `contacts-assistant:`. The
owner's own messages to a watched contact dispatch too: assistant-managed
contacts **answer the owner** (assistant mode responds to anyone, `me`
included), maintainer-managed contacts silently **record** the message in
that contact's session as context — never replied. Per contact, dispatch writes the message to a task file, symlinks
the chosen agent md as `AGENTS.md` in the contact's root (the harness cwd),
and runs the rendered harness template headless — one invocation per message,
the session resumed via the template's own session flags. A
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
  (`{"status":"ignored"}`). Exception: the **owner's own** messages in Bob's
  chat are always answered (assistant mode responds to anyone, `me` included).
- `filehelper` → always assistant (never record-only). The orchestrator
  agent declares it via `contacts-assistant: [filehelper]`.
- **Owner's messages in maintainer-managed chats** → recorded context-only
  into that contact's session (`{"status":"ignored"}`) so the maintainer
  persona keeps the full picture without ever answering as an AI.

A contact declared in both lists resolves to assistant. To monitor a contact
with no dedicated agent md, just list it under `contacts:` in any agent md —
the type default (individual/room maintainer) handles it in maintainer mode.

### Task payload & skill loading

Tasks are **self-contained**: the agent md (symlinked `AGENTS.md`) inlines the
only wechat-bro command a task needs (`send-text` via stdin pipe) — tasks do
**not** load the full wechat-bro skill protocol.

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

### Harness

Per-contact tasks run through **each harness's own CLI in headless mode** — one
invocation per message batch, session resumed each time, working directory set
to the contact's root folder so all relative reads/writes stay inside it.

Dispatch contract (any harness): non-interactive one-shot mode, resumable
session stored under the contact's `session/`, cwd = contact root. A `harness:`
set to a **bare name** picks that CLI's built-in template; `pi` is the default
when unset. Built-in names: `pi`, `claude`, `codex`, `copilot` — each bakes in
that CLI's headless/resume/approval flags (e.g. resume-or-first-run fallback,
`--allow-all`/skip-permissions so the agent can actually send). There are no
provider/model/thinking frontmatter keys — every such flag lives straight in
your template.

`harness:` (frontmatter, or the `--harness` flag to override every agent) is
either a built-in name or a custom shell command template run via
`/bin/sh -c`; `{var}` placeholders are substituted with shell-quoted values:

| placeholder | value |
|---|---|
| `{task}` | task file name relative to the task cwd |
| `{task-path}` | absolute task file path |
| `{session-dir}` / `{session-id}` | where the harness stores/resumes that contact's history |
| `{cwd}` | task working directory (the contact root) |
| `{contact}` / `{name}` | chat being served / agent name |
| `{timeout}` | dispatch timeout in seconds (frontmatter `timeout:`) |

Example custom templates (when the built-ins don't fit):

```markdown
harness: claude -p --session-id {session-id} --append-system-prompt "$(cat AGENTS.md)" < {task}
harness: codex exec resume {session-id} < {task-path}
```

`${VAR}` shell forms and unknown placeholders are left untouched.
## Lifecycle & Startup Contract

Two long-lived processes make up a running system — both must **outlive any
agent session**, because messages arrive 24/7 whether or not an agent is
running:

| process | command | holds |
|---|---|---|
| **daemon** | `wechat-bro --daemon` | headless Chrome + WeChat login, serves `ws://localhost:9231` |
| **orchestrator** | `wechat-bro orchestrator` | watch list + dispatch loop (connects to the daemon — spawning one as a child if none runs — reconnects forever) |

Never start them as ordinary foreground children of an agent session — they
die with the session and the account goes deaf.

### The idempotent anchor: `wechat-bro up` / `down`

Every start path — agent, session hook, service manager, human — runs the
same command. It probes, starts only what is missing, waits for the daemon's
WebSocket, and reports one JSON line:

```bash
wechat-bro up                    # spawn daemon + orchestrator detached (skip ones already running)
wechat-bro up --harness '<tpl>'  # same flags as `orchestrator` (--harness, --port, --timeout)
wechat-bro down                  # stop orchestrator, then daemon (graceful cookie flush)
wechat-bro status                # login/contacts state — exit 0 = daemon alive
```

- Detached, with logs in `~/.wechat-bro/daemon.log` and `orchestrator.log`.
- Both processes register `~/.wechat-bro/{daemon,orchestrator}.pid`, so
  `down`/`up` find them even when a service manager started them.
- `up` does not log in for anyone: on a first (or expired) session it
  reports `loggedIn:false` and the daemon broadcasts a `scan` event — open
  the QR URL (auto-popped in a browser) and scan with the phone. Later
  restarts reuse saved cookies until WeChat expires them.
- `up` is safe to run unconditionally at any time — already-running parts
  are left untouched (a concurrent hook + manual start cannot double-spawn).

### Choosing how it starts — the decision table

When the user asks to "start the orchestrator", pick a start mode
(deliberately, with the user — don't silently default to a foreground
process that dies with your session):

| mode | outlives your session | survives reboot | crash auto-restart | choose when |
|---|---|---|---|---|
| **detached** — `wechat-bro up` | ✅ | ❌ | ❌ | first run / trial (default) |
| **background service** — launchd / systemd user units running `wechat-bro --daemon` + `wechat-bro orchestrator` | ✅ | ✅ | ✅ | always-on coverage — promote once the user confirms it works |
| **agent session hook** — hook runs `wechat-bro up` at session start | starts on demand | ❌ | ❌ | wanted only while agents are active |
| **manual** — user runs `wechat-bro up` themselves | ✅ | ❌ | ❌ | user prefers full control |

Hook composes with everything: `wechat-bro up` is a fast no-op when
nothing is missing, so an unconditional session-start hook costs ~0.1s.

### Mode setup

**Detached** — run `wechat-bro up`, verify `wechat-bro status` reports
`loggedIn` / `contactsReady`, done.

**Background service** — one service definition per process (start order
doesn't matter: the orchestrator retries its connect). Resolve absolute
paths first — service managers run with a minimal PATH:

```bash
WB=$(command -v wechat-bro)                 # e.g. /opt/homebrew/bin/wechat-bro
CLI=$(dirname $(realpath "$WB"))/cli.js     # the real cli.js
NODE=$(command -v node)
```

macOS launchd — `~/Library/LaunchAgents/com.wechat-bro.daemon.plist`
(copy with `orchestrator` in ProgramArguments for the second one):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.wechat-bro.daemon</string>
  <key>ProgramArguments</key><array>
    <string>NODE</string><string>CLI</string><string>--daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/USER/.wechat-bro/daemon.log</string>
  <key>StandardErrorPath</key><string>/Users/USER/.wechat-bro/daemon.log</string>
</dict></plist>
```

Load: `launchctl bootstrap gui/$(id -u) <plist>` (bootout to unload).

Linux systemd — `~/.config/systemd/user/wechat-bro-daemon.service` (and
`wechat-bro-orchestrator.service` with `ExecStart=… orchestrator`):

```ini
[Unit]
Description=wechat-bro daemon
[Service]
ExecStart=NODE CLI --daemon
Restart=always
RestartSec=3
[Install]
WantedBy=default.target
```

Enable: `systemctl --user enable --now wechat-bro-daemon
wechat-bro-orchestrator` and `sudo loginctl enable-linger $USER` (without
linger, user units die at logout).

**Agent session hook** — wire `wechat-bro up` into the harness's
session-start primitive. Claude Code example (`~/.claude/settings.json`):

```json
{ "hooks": { "SessionStart": [ { "hooks": [
  { "type": "command", "command": "wechat-bro up" }
] } ] } }
```

Any other harness implements the same contract with whatever session-start
hook / startup instruction it has: shell out to `wechat-bro up`, ignore the
JSON line on stdout.

### Configure before starting (harness contract)

The orchestrator dispatches contact tasks through a **harness template** —
configure it for the agent CLI that will serve contacts BEFORE `up` (or at
least before the first real message):

1. Write `~/.wechat-bro/agents/wechat-orchestrator.md` (overrides the bundled
   default), declaring `contacts-assistant: [filehelper]` and the harness to
   serve with — a bare name (`harness: claude`) or a custom template, see
   Harness above. Agent mds reload per incoming message, so edits apply live.
2. Alternatively pass `wechat-bro up --harness '<tpl|name>'` to override
   every agent's harness — this needs a restart (`down` + `up`) to change.

### First-start runbook (what the agent does when asked to "start it")

1. **Probe**: `wechat-bro status` — exit 0 means the daemon is alive.
   Running `up` unconditionally is fine (idempotent).
2. **Configure** the harness for the current agent (above) if not done.
3. **Choose the start mode** with the user per the decision table — default
   detached `up`; offer service promotion once the user confirms it works.
4. **Start & verify**: `wechat-bro up` → `wechat-bro status` shows
   `loggedIn`, `contactsReady`.
5. **If `loggedIn:false`**: point the user at the QR URL the daemon popped
   open; when login completes the daemon announces `✅✅✅✅✅` to
   filehelper. Nothing is monitored until that scan happens.