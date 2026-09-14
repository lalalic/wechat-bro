# Worker `next_action`: scheduled self-wakeup with handoff context

## Motivation

The current orchestrator is almost entirely event-driven: a WeChat message arrives,
the matching contact/room worker runs once, then exits. Its final JSON result can
report only whether the task was addressed, ignored, or escalated.

That works for passive conversation maintenance, but not for delegated activities
that must remain responsible for a topic over time. A discussion host is the first
concrete example:

1. a room agent opens a discussion;
2. it waits for people to respond;
3. if somebody replies before the planned follow-up, the incoming message should wake the agent immediately;
4. after handling the new state, the agent should decide when (if ever) it should proactively return to the discussion;
5. when it returns, it needs the intent/handoff from the previous turn, not merely a timer event.

The LLM itself should not remain running between turns. The durable orchestrator
owns scheduling; each worker invocation decides what should happen next.

## Existing contract

Today a worker ends stdout with exactly one parseable result line such as:

```json
{"status":"addressed"}
```

```json
{"status":"ignored"}
```

```json
{"status":"escalated","question":"What the owner must decide"}
```

`escalated` is already a form of continuation: the orchestrator stores pending
state, waits for an owner event, and resumes the same contact session with context.
This enhancement generalizes that idea to time-based continuation without changing
the existing status meanings.

## Proposed result contract

Add an optional `next_action` object to a worker result.

Initial action type:

```json
{
  "status": "addressed",
  "next_action": {
    "type": "wake",
    "after_seconds": 1800,
    "reason": "Check whether the room discussion has stalled after the opening question",
    "context": "If nobody has added a substantive reply, ask one short follow-up about the biggest adoption concern. If discussion is already active, do not interrupt merely because this wakeup fired."
  }
}
```

### Fields

- `type` — initially only `"wake"`.
- `after_seconds` — requested delay from completion of the current task. The orchestrator converts this to an absolute durable `due_at` timestamp.
- `reason` — concise human-readable purpose of the future wakeup; useful for logging/diagnostics and for the next task prompt.
- `context` — handoff from the current worker to its future invocation. This is task context, not durable contact memory. It should explain what to inspect, what decision to make, and any intended conversational move.

`next_action` is optional. If absent/null, the agent returns to normal event-driven
behavior and will run again only when another event routes to it.

The existing `status` remains authoritative for the current task. In particular,
`escalated` keeps its existing owner-decision semantics. This enhancement should
not encode escalation as a `next_action` type in the first version.

## Orchestrator semantics

### Schedule ownership

The worker only requests a continuation. The orchestrator owns all actual timers,
persistence, bounds, cancellation, and wakeup execution.

A worker must not keep a sleeping process alive and must not directly create an OS
cron/PM2 timer.

### Replacement semantics

There is at most one pending scheduled wakeup per routed agent/session/contact.

Every completed worker turn replaces the previous pending wakeup:

- result contains `next_action.type = "wake"` → persist/schedule the new wakeup;
- result has no `next_action` → clear any previous pending wakeup;
- invalid `next_action` → log/reject it and do not silently create a timer.

This makes each worker result the authoritative plan for “what should I do next?”.

### Incoming message before the timer

If a normal WeChat event arrives before the scheduled wakeup:

1. cancel/supersede the pending timer before launching that contact's next task;
2. run the agent immediately with the real incoming message;
3. include the prior pending `reason/context` as optional planning context when useful, clearly marked as a superseded plan rather than a user message;
4. after that task finishes, its result becomes the new authoritative `next_action` and therefore chooses a new wakeup time or none.

This prevents a stale timer from firing immediately after the agent has already
handled newer conversation state.

### Scheduled wake task

When `due_at` arrives, invoke the same routed agent/session as a synthetic
orchestrator task. The prompt must clearly distinguish it from an incoming WeChat
message, for example:

```text
SCHEDULED WAKEUP — no new user message triggered this task.
Reason: ...
Handoff from your previous turn: ...
Inspect the current conversation/session state and decide whether any outbound
message/action is appropriate. You may remain silent. Return the normal JSON
result contract, including a new next_action if responsibility should continue.
```

The scheduled invocation may send a WeChat message, remain silent, escalate, end
its continuation, or schedule another wakeup.

### Persistence and restart

Pending wakeups must survive orchestrator restart. Persist enough information to reconstruct:

- target agent/contact/session identity;
- `due_at`;
- `reason`;
- `context`;
- creation/update timestamp and an opaque schedule id/version if needed to reject stale callbacks.

On startup:

- reload pending wakeups;
- future wakeups are rescheduled;
- overdue wakeups run once promptly (subject to a bounded grace policy), rather than being dropped or repeated indefinitely.

### Concurrency

Scheduled wakeups must use the same per-contact serialization as incoming message
tasks. A timer and a real incoming message must never run the same contact worker
concurrently.

A stale timer callback must not execute after a newer incoming event/task has
superseded that schedule.

### Bounds and safety

The orchestrator should enforce configuration-level bounds rather than trusting
arbitrary worker timing. Initial implementation should define sane minimum and
maximum delays and log when a request is clamped/rejected.

Do not invent periodic polling when `next_action` is absent.

## Why `after_seconds` + handoff instead of a naked timer

The feature is not “sleep and wake me up.” It delegates ongoing responsibility.
The important artifact is the future intent:

- **when** should I reconsider the situation?
- **why** am I coming back?
- **with what handoff/context** should my future self reason?

The timer is only the transport for that delegated continuation.

## First intended use: hosted discussion

A future `host` / `host discussion` command can use this primitive without
requiring a permanently-running LLM worker:

```text
host command
  -> run room agent immediately with topic/background/style/goal
  -> agent sends opening message
  -> result.next_action asks to wake later with discussion-host handoff
  -> incoming room messages supersede the timer and wake the agent immediately
  -> each turn chooses a new next_action
  -> when the topic is finished, omit next_action and return to passive mode
```

The `host` CLI/API itself is intentionally out of scope for this PR. This PR
creates the reusable orchestrator continuation primitive that `host` can build on.

## Acceptance criteria

1. `parseTaskResult` remains backward compatible with existing result lines.
2. A valid optional `next_action.wake` is parsed and validated.
3. A worker result can persist one future wakeup with reason + context.
4. A future wakeup invokes the same contact/room session through normal task serialization and injects the saved handoff context.
5. A real incoming message before `due_at` supersedes the pending wakeup and the worker's new result determines the next schedule.
6. A result without `next_action` clears the previous pending continuation.
7. Pending wakeups survive orchestrator process restart without duplicate fires.
8. Stale timer callbacks cannot run after a schedule has been replaced/cancelled.
9. Existing escalation behavior remains unchanged.
10. Tests cover parsing/validation, scheduling, replacement by incoming message, restart recovery, overdue wake behavior, cancellation, and contact serialization.
11. Documentation describes the worker result contract and scheduled-wakeup task semantics.

## Non-goals

- Implementing the user-facing `host discussion` command in this PR.
- Keeping an LLM/harness process resident while waiting.
- General cron/recurring-job infrastructure.
- Multiple simultaneous scheduled continuations for one contact/session.
- Replacing the existing escalation flow.
- Making `context` durable relationship memory; persistent facts still belong in the contact's normal memory/rules/knowledge mechanisms.
