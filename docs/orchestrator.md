# The wechat-bro Orchestrator

How `wechat-bro orchestrator` turns incoming WeChat messages into resumable
agent tasks — and their replies back into WeChat messages.

Source: `src/orchestrator.js` (entry via `src/cli.js`, first positional arg
`orchestrator`). Full frontmatter/harness reference:
[`skills/wechat-bro/SKILL.md`](../skills/wechat-bro/SKILL.md).

---

## 1. Big picture

The orchestrator is a **file-driven agent dispatcher**. It is a plain
WebSocket *client* of the wechat-bro daemon (the Chrome process logged into
wx.qq.com). It watches the contacts declared in agent `*.md` frontmatter and,
for every incoming message, renders a task file and runs a headless harness
CLI (pi by default) rooted in the contact's own folder. The account owner
talks to it through **filehelper** (文件传输助手).

```mermaid
flowchart LR
    subgraph WeChat
        C["Contacts / Rooms"]
        FH["filehelper<br/>(owner's control channel)"]
    end

    subgraph daemon ["Daemon (child process)"]
        CH["Chrome + wx.qq.com<br/>(wechat-bro.js inject)"]
        WS["ws-server :9231<br/>broadcasts message events"]
    end

    subgraph orch ["Orchestrator (this process)"]
        RT["onEvent: replay check<br/>→ watch list → routeAgent"]
        DSP["dispatch: task file<br/>+ AGENTS.md symlink"]
        Q["ContactQueue<br/>(serial per contact)"]
    end

    subgraph tasks ["Harness tasks (headless, one per message)"]
        P1["pi -p … @{task}"]
        P2["claude -p …"]
        P3["codex exec …"]
        P4["copilot -p …"]
    end

    C <-->|"messages / replies"| CH
    FH <-->|"guidance / escalations"| CH
    CH --- WS
    WS -->|"event: message"| RT
    RT --> DSP --> Q --> P1 & P2 & P3 & P4
    P1 & P2 & P3 & P4 -->|"send-text via WS"| WS
    P1 & P2 & P3 & P4 -->|"stdout JSON result line"| Q
```

Key invariants:

- **One harness invocation per message batch** — the session is *resumed* via
  the harness's own session flags, not held in memory.
- **Per-contact serialization** — a contact's task never runs concurrently
  with itself (`ContactQueue`).
- **No long argv** — the message goes into a task file (`@{task}` /
  `$(cat {task})`); the agent persona is a **symlinked `AGENTS.md`**, never an
  argument (EDR kills >1KB command lines).

---

## 2. Daemon lifecycle

The orchestrator owns its daemon: it adopts one already listening, otherwise
spawns one **as a child process** that lives and dies with it.

```mermaid
flowchart TD
    A["wechat-bro orchestrator<br/>(--port, --harness, --daemon)"] --> B{"probeDaemon(port)<br/>waits for 'connected' event"}
    B -->|"answers"| D["adopt: connect as WS client"]
    B -->|"silent"| E{"--daemon flag?<br/>or NO_DAEMON_SPAWN=1?"}
    E -->|"spawn enabled"| F["spawn child:<br/>node cli.js --daemon<br/>logs → ~/.wechat-bro/daemon.log"]
    F --> G["poll probeDaemon<br/>(60 × ~1.5s, Chrome boot)"]
    E -->|"no spawn"| H["retry loop only"]
    G --> D
    D --> I["connected — watching"]
    I -->|"socket close"| J["wait 3s"]
    J --> B
    A -->|"SIGINT / SIGTERM"| K["close WS<br/>SIGTERM daemon child<br/>exit 0"]
```

- `--daemon` forces a fresh child **even when a port already answers**.
- `WECHAT_BRO_NO_DAEMON_SPAWN=1` disables spawning (unit tests: no Chrome).
- If the initial connect fails, the connect loop retries **forever** every 5s,
  (re)spawning the child whenever nothing listens — so service managers may
  start it before the daemon is reachable.
- `wechat-bro exit` shuts the daemon down; a *running* orchestrator simply
  respawns it ~3s later. Killing the orchestrator stops everything.

---

## 3. Agent mds, watch list, routing

Agent files load from **one user dir** `~/.wechat-bro/agents/` (plain `.md`,
legacy `.agent.md` accepted) with the skill's bundled `agents/` as fallback
defaults, keyed by `name:` (user wins). They are **reloaded on every incoming
message**, so edits apply immediately.

```mermaid
flowchart TD
    M["incoming message<br/>(data.from, data.to, sender)"] --> R{"ts < startedAt?"}
    R -->|"yes"| X0["drop: replayed"]
    R -->|"no"| W{"from ∈ watch list?<br/>or from = me → to watched / filehelper"}
    W -->|"no"| X1["ignore"]
    W -->|"yes"| L["loadAgents()<br/>(--harness overrides all)"]

    L --> ME{"from = me?"}
    ME -->|"to = filehelper"| ESC{"pending<br/>escalation?"}
    ESC -->|"yes"| E1["route reply to that contact's session<br/>(maintainer mode, answer delivered)"]
    ESC -->|"no"| E2["orchestrator agent<br/>(assistant mode)"]
    ME -->|"to = watched contact"| OV{"assistant-managed?"}
    OV -->|"yes"| O1["assistant mode —<br/>answers the owner"]
    OV -->|"no"| O2["record-only —<br/>context into session, no reply"]

    L --> NOTME["from = contact"]
    NOTME --> RT{"routeAgent"}
    RT -->|"contacts-assistant match"| A1["assistant-managed"]
    RT -->|"contacts match"| A2["maintainer"]
    RT -->|"type: contact/room<br/>unrestricted fallback"| A3["maintainer"]
    A1 --> P{"text has ?! / ？！"}
    P -->|"ping"| A4["assistant mode<br/>(reply to that msg only)"]
    P -->|"no ping"| A5["record-only"]
    A2 & A3 --> A6["maintainer mode —<br/>reply as the owner"]
```

The watch list is the union of all `contacts:` + `contacts-assistant:`
across non-orchestrator agents (filehelper excluded — it is always handled;
contact lists on a `type: orchestrator` agent are declarative only and
ignored). `routeAgent` also asks the daemon `get-contact` (cached per
connection) to distinguish rooms.

### How the full watch list is built

Yes — it is collected from **all** agent md files, every time a message
arrives:

```mermaid
flowchart LR
    U["~/.wechat-bro/agents/*.md<br/>(user dir — wins)" ] --> M{"merge by name:"}
    P["skills/wechat-bro/agents/*.md<br/>(skill-bundled defaults)" ] --> M
    M --> W["watch list = union of<br/>contacts: + contacts-assistant:" ]
    W --> X["minus filehelper —<br/>always the owner channel" ]
```

- `loadAgents()` reads the user dir and the bundled defaults and merges them
  **by frontmatter `name:`** — a user md with the same name replaces the
  bundled one entirely.
- `watchList()` unions `contacts:` + `contacts-assistant:` across the merged
  set, skipping `type: orchestrator` agents — a contact listed in *any*
  contact/room agent md is watched; nothing else is. The orchestrator's own
  `contacts-assistant: [filehelper]` is declarative only, so a stray name in
  its frontmatter can never hijack routing into the orchestrator's fixed
  session.
- Reloaded **per incoming message**, so edits and new files apply on the next
  message without a restart.
- `runOrchestrator` removes `filehelper` from the set: it is not routed as a
  normal contact but always dispatched to the `type: orchestrator` agent in
  assistant mode (or used for escalation replies).
- The watch list is the **gate**: an external message whose sender is not in
  the set is ignored before routing. `routeAgent`'s unrestricted `type:`
  fallback only applies to contacts that passed the gate (or the owner's own
  messages to a watched chat).

---

## 4. Dispatch — one message, one task

`makeDispatcher` builds one closure per orchestrator run; per contact it
resolves paths, writes the task, and enqueues the spawn.

```mermaid
sequenceDiagram
    autonumber
    participant WS as ws-server (daemon)
    participant O as Orchestrator
    participant F as Filesystem (contact root)
    participant H as Harness CLI (e.g. npx pi)
    participant FH as filehelper

    WS->>O: event "message" (broadcast)
    O->>O: replay check → watch list → loadAgents → routeAgent
    O->>O: decide mode (assistant / maintainer / record-only)
    O->>F: write .task-{ts}.md (renderTask: persona + msg JSON + contract)
    O->>F: refresh AGENTS.md symlink → agent md
    O->>O: render harness template ({task},{session-id},{cwd},… shell-quoted)
    O->>FH: optional notify note (notify: true, needs-response only)
    O->>H: spawn via /bin/sh -c (rendered template, cwd = contact root)
    Note over O,H: ContactQueue serializes per contact — timeout SIGKILL (default 900s)
    H->>F: read/write memory.md, rules.md, session history
    H->>WS: {"cmd":"send-text","to":"…","content":"reply"}
    WS->>H: ok
    H-->>O: stdout ends with {"status":"addressed"|"ignored"|"escalated",…}
    O->>O: parseTaskResult (scan last lines backwards)
    alt status = escalated
        O->>FH: 🤖❓ 请示 — contact + question
        O->>O: pendingEscalations.set(contact, question)
    else exit code ≠ 0
        O->>FH: ⚠️ task failed (exit N) + stdout tail
    end
    O->>F: delete task file
```

Fixed vs derived paths:

| | `type: orchestrator` agent | contact agents |
|---|---|---|
| cwd | `~/.wechat-bro` (DATA_DIR) | frontmatter `cwd:` or `contacts/<sanitized contact>/` |
| session-dir | `~/.wechat-bro/session` | `<cwd>/session` |
| session-id | `wechat-orchestrator` | `wechat-<sanitized contact>` or frontmatter |

---

## 5. Task payload & the three modes

The rendered task file contains: a header (who sent what), the message as
JSON, a mode paragraph, and the result contract. Modes are **mutually
exclusive per task**:

| mode | when | behaviour |
|---|---|---|
| **Assistant** | filehelper (always) · `?!` ping · `contacts-assistant` ping · owner's message in an assistant-managed chat | answer openly as an AI, reply **must** start with 🤖 |
| **Maintainer** | dedicated `contacts:` match, or type fallback | converse **as the account owner**; never reveal AI; send reply via wechat-bro |
| **Record-only** | assistant-managed contact without ping; owner's message in maintainer-managed chat | absorb as context (memory.md), **never reply**, end `{"status":"ignored"}` |

Result contract (parsed from the **last** parseable JSON line of stdout; a
missing/garbled line degrades to `addressed` so the loop never stalls):

| result | orchestrator action |
|---|---|
| `{"status":"addressed"}` | nothing (reply already sent by the agent) |
| `{"status":"ignored"}` | nothing |
| `{"status":"escalated","question":…}` | filehelper `🤖❓ 请示` + hold for routing (contact agents only) |

---

## 6. Escalation loop

```mermaid
sequenceDiagram
    autonumber
    participant A as Agent task (contact session)
    participant O as Orchestrator
    participant FH as filehelper (owner)
    participant C as Contact

    A->>A: can't decide → send nothing
    A-->>O: {"status":"escalated","question":"…"}
    O->>FH: 🤖❓ 请示 — Alice: "she asks for a refund, OK?"
    Note over O: pendingEscalations.set("Alice", question)
    FH->>O: me → filehelper: "approve, but only 50%"
    O->>O: pop oldest escalation, re-route Alice
    O->>A: next task for Alice's session:<br/>"owner answers: 'approve, but only 50%'<br/>— deliver their words, natural tone"
    A->>C: reply (maintainer voice)
    A-->>O: {"status":"addressed"}
```

Only the **oldest** pending escalation is consumed per owner reply; questions
are held per contact until answered.

---

## 7. Harness templates

`harness:` (frontmatter) or `--harness` (CLI, overrides every agent) is either
a **bare name** → built-in template, or a custom `/bin/sh -c` command line
with `{var}` placeholders (unknown placeholders and `${VAR}` shell forms are
left verbatim; values are shell-quoted).

| name | built-in template (resumed ‖ first-run fallback) |
|---|---|
| `pi` (default) | `npx pi -p --session-dir {session-dir} --session-id {session-id} --thinking off --no-skills @{task}` |
| `claude` | `claude -p --dangerously-skip-permissions --continue < {task} ‖ claude -p … < {task}` |
| `codex` | `codex exec resume --last --skip-git-repo-check --sandbox danger-full-access "$(cat {task-path})" ‖ codex exec … - < {task-path}` |
| `copilot` | `copilot --continue -p "$(cat {task})" --allow-all -s ‖ copilot -p "$(cat {task})" --allow-all -s` |

Placeholders: `{task}` `{task-path}` `{session-dir}` `{session-id}` `{cwd}`
`{contact}` `{name}` `{timeout}`. Each CLI's headless/resume/approval
conventions live **in its template** — the orchestrator hardcodes none.

---

## 8. Running it

```bash
wechat-bro orchestrator                 # adopt or spawn daemon, watch, dispatch
wechat-bro orchestrator --port 9500     # custom WS port
wechat-bro orchestrator --harness claude
wechat-bro orchestrator --daemon        # force a fresh daemon child
wechat-bro exit                         # stop daemon (a running orchestrator respawns it)
```

Stop with Ctrl-C / SIGTERM — the WS closes and the daemon child is killed.
Startup logs list loaded agent mds, the watch list, every dispatch
(`agent ← contact`), task durations, and parsed results on stderr.
