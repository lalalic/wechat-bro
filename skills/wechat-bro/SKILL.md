---
name: wechat-bro
description: 让 AI harness 操作和定制微信：启动内置 orchestrator、管理关注联系人和行为、处理 escalation、调用微信命令，或构建自定义 listener/orchestrator。
---

# wechat-bro — 微信 Agent Skill

## 这个 skill 能做什么

当 AI harness 需要使用微信时，优先使用本 skill。核心能力有 5 个：

1. 从 harness 启动并运行内置 `wechat-bro orchestrator`。
2. 让账号主人通过 `filehelper` 管理 watch list、watch mode、联系人/全局 rules 和长期 memory；修改后下一次 dispatch 立即生效，无需重启。
3. 正确执行 contact agent → orchestrator → 账号主人 → 原 contact session 的 escalation 流程。
4. 根据具体目的选择正确的 `wechat-bro` command。
5. 当内置 orchestrator 不够用时，直接基于 WebSocket + JSON command 构建自定义 listener/orchestrator。

默认优先使用内置 orchestrator；WebSocket/command protocol 是自定义自动化的底层能力。

## 1. 启动内置 orchestrator

普通的长期微信 agent 场景，直接启动：

```bash
npx wechat-bro orchestrator
```

orchestrator 会：

- 连接已有 `wechat-bro` daemon；没有时按需启动 child process；
- 通过 `filehelper` 与账号主人沟通；
- 每条新消息到来时重新加载 agent markdown；
- 从 agent frontmatter 生成 watch list；
- 将被关注的聊天 dispatch 到各自独立、可续跑的 contact session；
- 将失败和 escalation 通过 `filehelper` 报给主人。

常用参数：

```bash
npx wechat-bro orchestrator --harness codex
npx wechat-bro orchestrator --harness claude
npx wechat-bro orchestrator --harness copilot
npx wechat-bro orchestrator --harness pi
npx wechat-bro orchestrator --port 9231
```

`pi` 是默认 harness。也可以在 agent frontmatter 的 `harness:` 或 `--harness` 中提供 custom shell template。

### Harness dispatch contract

每个 contact task 都应满足：

- cwd = `~/.wechat-bro/contacts/<contact>`；
- 每个联系人/群一个独立、可恢复的 session；
- 当前 agent markdown 通过 contact cwd 下的 `AGENTS.md` 暴露给 harness；
- task file 包含本次微信 event，以及明确的 mode/context-only 指令。

**绝不要把两个联系人混到同一个 session。**

## 2. 管理 watch list、mode、rules 和 memory

账号主人通过 `filehelper` 用自然语言管理系统。`type: orchestrator` agent 应理解例如：

- `关注 Alice` → 以 maintainer mode 关注 Alice；
- `以 assistant 模式关注 Bob` → 以 assistant-managed mode 关注 Bob；
- `取消关注 Alice` → 从 watch 配置中移除 Alice；
- `把 Alice 改成 assistant` / `改回 maintainer` → 修改 watch mode；
- `以后跟 Alice 用正式一点的语气` → 更新 Alice 的 contact rules；
- `以后所有联系人都不要透露我的住址` → 更新 global rules；
- `Alice 喜欢英文简短回复` → 有长期价值时写入 Alice 的 contact memory。

`~/.wechat-bro/agents/` 下的 agent 文件会在每条新消息时重新加载，因此 watch/mode/agent-definition 的修改会在**下一次 dispatch** 生效，不需要重启 orchestrator。

### Watch-list model

有效 watch list 是所有 agent frontmatter 中以下字段的并集：

```markdown
contacts: [Alice]             # 默认 maintainer mode
contacts-assistant: [Bob]     # assistant-managed mode
```

同一联系人 routing 优先级：

1. 精确匹配 `contacts-assistant:`；
2. 精确匹配 `contacts:`；
3. 不限制 contact 名称的默认 `type: contact` / `type: room` agent。

同一名字同时出现在两个列表时，按 assistant mode 处理。

`filehelper` 专门用于账号主人，并始终由 orchestrator 以 assistant mode 处理。

### Modes

**Maintainer mode** 是 `contacts:` 的默认模式。contact agent 以账号主人的自然沟通方式维护对话，不主动暴露 AI/orchestrator 内部实现；需要主人决定的事情必须 escalation。

单条消息以 `?!` 或 `？！` 明确呼叫 AI 时，该消息提升为 assistant mode。

**Assistant-managed mode** 由 `contacts-assistant:` 指定。普通联系人消息是 context-only；只有显式 `?!` / `？！` 呼叫 AI 的消息才回复。账号主人自己在该聊天中的消息仍可作为 assistant task 回答。

orchestrator 生成的 task payload 对 mode/context-only 具有最终解释权；contact agent **执行 payload 指定的模式，不自行重新推断 routing**。

### Rules 和 memory

持久化目录位于 `WECHAT_BRO_DATA_DIR`，默认是 `~/.wechat-bro`：

```text
~/.wechat-bro/
├── rules.md
├── memory.md
├── agents/
└── contacts/<contact>/
    ├── rules.md
    ├── memory.md
    ├── knowledge/
    ├── download/
    └── session/
```

约定：

- `rules.md`：控制未来行为的指令；
- `memory.md`：值得长期记住的事实/上下文；
- global 文件：所有联系人共享；
- contact 文件：只适用于某个联系人或群。

contact rules 可以有意特化 global rules；agent 自身的安全/角色约束优先级始终更高。

例子：

```text
# ~/.wechat-bro/rules.md
不要向联系人透露账号主人的家庭住址。
```

```text
# ~/.wechat-bro/contacts/Alice/rules.md
和 Alice 使用简短、专业的英文沟通。
```

```text
# ~/.wechat-bro/contacts/Alice/memory.md
Alice 在 Project Atlas 工作，通常喜欢简短回复。
```

## 3. Escalation

当 agent 无法在不替主人做决定的情况下安全、真实地继续时，要 escalation。典型场景：

- 新建或改变承诺/约定；
- 授权付款、借钱或其它金钱决定；
- 披露隐私/敏感信息；
- 替主人做其它重要决定；
- 关键事实无法可靠确认。

如果 rules/context 已经明确授权一个安全的事实回答，不要仅因为话题涉及日程、金钱或隐私就机械 escalation。

### Escalation path

```text
contact message
    ↓
contact agent
    ↓  {"status":"escalated","question":"..."}
orchestrator
    ↓  🤖❓ 通过 filehelper 请示
account owner
    ↓  通过 filehelper 回答
orchestrator
    ↓  路由回同一 contact 的既有 session
contact agent
    ↓  自然转达
contact
```

在返回 `escalated` 之前，contact agent 可以先发送一句自然的等待回复，例如：`我确认一下，稍后回复你。`

主人答案返回同一 contact session 后，使用 maintainer mode 自然转达；只有真正有长期价值时才把结论写入 `rules.md` 或 `memory.md`。

### Task result contract

每个 contact task 最后一行必须严格是一个 JSON result：

```json
{"status":"addressed"}
{"status":"ignored"}
{"status":"escalated","question":"<主人需要决定什么，含必要背景>"}
```

语义必须稳定：

- `addressed`：已经执行 outbound reply/action；
- `ignored`：没有 outbound reply/action，因为无需回复或 task 是 context-only；
- `escalated`：需要账号主人输入后才能继续完成。

如果需要微信回复/动作，必须先执行，再输出最后一行 result。

## 4. 根据目的选择 command

联系人通过精确 `name` 标识。账号主人是 `me`。`filehelper` 与 `文件传输助手` 指向同一个系统聊天。

| 目的 | Command |
|---|---|
| 列出个人联系人 | `contacts` |
| 列出群聊 | `rooms` |
| 查看一个联系人/群详情 | `get-contact` |
| 列出群成员 | `room-members` |
| 发送文本 | `send-text` |
| 发送本地图片 | `send-image` |
| 发送任意文件 | `send-file` |
| 转写本地音频并发送文本 | `send-voice` |
| 检查登录/联系人加载状态 | `status` |
| 列出支持的 emoji code | `emojis` |
| 正常退出 | `exit` |

### Command examples

```bash
npx wechat-bro contacts
npx wechat-bro rooms
npx wechat-bro get-contact --name "Alice"
npx wechat-bro room-members --name "Dev Team"
```

agent action 常用 stdin JSON：

```bash
echo '{"cmd":"send-text","to":"Alice","content":"hello"}' | npx wechat-bro

echo '{"cmd":"send-image","to":"Alice","path":"/tmp/photo.jpg"}' | npx wechat-bro

echo '{"cmd":"send-file","to":"Alice","path":"/tmp/report.pdf","filename":"report.pdf"}' | npx wechat-bro
```

`send-voice` **不会**发送原生微信语音气泡；它会使用 Whisper 转写本地音频，然后把转写文本发送出去。

### Contact ambiguity

当名字匹配 0 个或多个联系人时，绝不要猜。把 resolution error 告诉用户，请用户提供可唯一识别的名字/remark name。

### 群 @mention

必须使用精确格式：

```text
@"Alice Chen"
```

例如：

```json
{"cmd":"send-text","to":"Dev Team","content":"@\"Alice Chen\" 请看一下 PR"}
```

未加双引号的 `@Alice Chen` 只是普通文本，不是结构化 mention。群成员即使不是个人联系人，也可以在群里 @；但不能因此直接 DM。

### Markdown 和生成资产

`send-text` 支持轻量 markdown 转换。以下 fenced block 会自动生成文件：

- `mermaid` → `diagram.png`；
- `marpit` → `slides.pdf`。

block 外文字仍按普通消息发送；多个 block 按出现顺序处理。

## 5. 构建自定义 listener / orchestrator

内置 orchestrator 不是必需的。需要自定义自动化时，直接连接：

```text
ws://localhost:9231
```

自定义 listener 可以：

1. 连接 WebSocket daemon；
2. 接收 event；
3. 自己过滤联系人/消息；
4. 调用任意 agent 或业务逻辑；
5. 再通过 JSON command 调用 `wechat-bro`。

最小 Node.js listener：

```js
const WebSocket = require('ws')
const ws = new WebSocket('ws://localhost:9231')

ws.on('message', async (raw) => {
  const event = JSON.parse(raw.toString())
  if (event.event !== 'message:text') return
  if (event.data.from !== 'Alice') return

  // custom logic here
})
```

当你需要自定义 routing、不同的 persistence model、业务工作流，或完全不同的 orchestrator 架构时，使用这一层。

## Protocol reference

### WebSocket events

Server event 以 JSON 广播：

```json
{"event":"message:text","data":{...},"ts":1785200000000}
```

重要 lifecycle event 包括：`connected`、`ready`、`scan`、`login`、`logout`、`contacts-ready`。

文本消息内容在 `data.Content`。

非文本 event 使用简化后的 `data.content`：

| type | `content` | extra |
|---|---|---|
| image | 下载后的图片路径 | |
| voice | Whisper 转写文本；失败时回退到音频路径 | `voiceFile` |
| video / microvideo | 下载后的 `.mp4` 路径 | |
| emoticon | emoji CDN URL | |
| location | 可读位置文本 | |
| card | 可读联系人卡片文本 | |
| verify / status | 可读文本 | |

下载媒体保存在对应 chat 的 `download/` 目录。

目前以下 incoming type 不会发出 event：`app` (49，包括文件附件/分享文章)、`system` (10000)、`recalled` (10002)。自定义 listener 不要假设这些 event 会到达。

### 群消息字段

群消息中：

- `from`：群/chat；
- `sender`：实际发言成员；
- `mentions`：解析后的 @ 列表；
- `mentionMe`：账号是否被 @。

### 内置 agent definitions

默认 agent 位于 `skills/wechat-bro/agents/`，作为 fallback。用户覆盖文件只放在：

```text
~/.wechat-bro/agents/
```

用户 agent 每条新消息都会重新加载，所以修改 frontmatter 或 instructions 后无需重启 orchestrator。

frontmatter 示例：

```markdown
---
name: wechat-alice
contacts: [Alice]
type: contact
harness: codex
session-id: wechat-alice
session-dir: ~/.wechat-bro/contacts/Alice/session
cwd: ~/.wechat-bro/contacts/Alice
timeout: 900
notify: true
---
Alice-specific instructions...
```

常用 frontmatter key：

- `name`：唯一 agent 名称；
- `contacts`：maintainer mode 关注的精确联系人名；
- `contacts-assistant`：assistant-managed mode 关注的精确联系人名；
- `type`：`contact`、`room` 或 `orchestrator`；
- `harness`：内置 harness 名称或 custom command template；
- `session-id`、`session-dir`、`cwd`、`timeout`、`notify`：dispatch 控制。

`type: orchestrator` 使用 data directory 下固定的 orchestrator cwd/session path。

### Harness template placeholders

custom harness command template 可以使用：

| placeholder | 含义 |
|---|---|
| `{task}` | 相对 cwd 的 task filename |
| `{task-path}` | task absolute path |
| `{session-dir}` | contact session directory |
| `{session-id}` | resumable session id |
| `{cwd}` | task working directory |
| `{contact}` | contact/chat 名称 |
| `{name}` | agent 名称 |
| `{timeout}` | task timeout 秒数 |

例如：

```markdown
harness: codex exec resume {session-id} < {task-path}
```

## 什么时候用哪一层

- 需要长期 personal WeChat agent、watch list、per-contact session/rules、escalation → **内置 orchestrator**。
- 只做一次发送消息、发送文件、查联系人等动作 → **direct commands**。
- 需要自己实现 listener、orchestrator 或业务自动化 → **WebSocket protocol**。
