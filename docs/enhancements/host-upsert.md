# `host` as a unified start-or-update discussion control

## Motivation

`wechat-bro host` currently serves as the entry point for proactively starting a hosted discussion. Once a hosted discussion is already active, the outer orchestrator may need to add new guidance without knowing or checking whether the target is still in an active host continuation.

Example: after a discussion has started, the owner/orchestrator wants to add guidance such as “if people still seem confused about the architecture, use a short flowchart at an appropriate moment, but do not send another message immediately.”

A separate `guide`, `nudge`, or `host-update` command would force callers to know the target's current hosting state and choose the right command. That is unnecessary state coupling.

## Objective

Make `host` the single idempotent control surface for both:

1. starting a new hosted discussion when no active continuation exists; and
2. updating / appending hosting guidance when an active continuation already exists.

The caller should be able to issue `host --to <target> --prompt <guidance>` without first checking whether the target is already being hosted.

## Fixed contact-session invariant

Every contact or room has exactly one configured contact session. The same
session is reused for normal inbound messages, host starts, host guidance
updates, escalation resumes, and scheduled wakes. A wake entry identifies its
contact/room with `session`; it never carries authority to override the
contact's current `session-id` or `session-dir`. Those values are resolved
from the current agent configuration at dispatch time.

## Desired semantics

### No active continuation

If the target has no pending host continuation / scheduled wakeup:

- behave as today's host start;
- resolve the existing configured room/contact agent;
- immediately run the same agent/session with a clearly marked `HOST DISCUSSION` synthetic task;
- let the worker send an opening message if appropriate;
- let the worker return `next_action` to continue hosting.

### Active continuation exists

If the same target already has an active continuation:

- treat the new `host` call as additional authoritative hosting guidance for the existing hosted discussion;
- supersede/cancel the existing pending wakeup before dispatching the new task so the stale timer cannot later fire;
- invoke the same configured agent/session immediately;
- include the prior pending `reason/context` only as clearly labeled superseded planning context;
- include the new `--prompt` as the current authoritative instruction;
- explicitly tell the worker that receiving new host guidance does **not** imply it must send a WeChat message immediately;
- let the worker inspect the current conversation state and choose whether to:
  - send something now,
  - stay silent,
  - escalate,
  - schedule a new `next_action`, or
  - end proactive hosting by omitting `next_action`.

The result of this new task becomes the authoritative continuation plan.

## Important rule: no separate host-mode state machine

Prefer deriving active hosting from the existing continuation state rather than introducing a separate durable `host_mode=true` flag.

The desired conceptual model is:

```text
host request
  -> current target state?
     -> no continuation: start host task
     -> active continuation: update host task + supersede old wake
  -> same agent/session runs now
  -> worker result decides new next_action (or none)
```

If implementation proves a small piece of additional metadata is necessary to distinguish host continuations from unrelated scheduled continuations, keep it minimal and explain why. Do not add a second scheduling loop or long-running resident LLM worker.

## CLI/API

Keep the existing command shape:

```bash
npx wechat-bro host --to "三人组" --prompt "<new host intent or guidance>"
```

Do not add `guide`, `nudge`, `host-update`, or require a caller-visible `--resume`/`--append` flag for the first version.

The outer caller should not need to know whether the target is currently hosting.

## Prompt semantics for an update

A host-update synthetic task should make the distinction explicit, for example:

```text
HOST GUIDANCE UPDATE

A hosted discussion for this target was already active.
The previous scheduled plan has been superseded by this new owner/orchestrator guidance.

Superseded plan (planning context only):
Reason: ...
Context: ...

New authoritative guidance:
...

Do not assume you must send a message immediately. Inspect the current conversation state and decide the best next action. Return the normal JSON result and a new next_action only if proactive responsibility should continue.
```

## Concurrency / replacement behavior

- Cancellation/supersession must happen before the update task is dispatched.
- The update task uses the same per-contact serialization as normal inbound messages and scheduled wakes.
- The old wake callback must become stale and must never execute after the host update supersedes it.
- If a real incoming message races with a host update, normal per-contact serialization must prevent concurrent worker invocations; whichever task completes later becomes the authoritative continuation plan according to the existing scheduling/version semantics.

## Example

Initial call:

```bash
wechat-bro host --to "三人组" --prompt "Start a discussion about wechat-bro and ask for honest product feedback."
```

Worker returns:

```json
{
  "status": "addressed",
  "next_action": {
    "type": "wake",
    "after_seconds": 600,
    "reason": "Check whether the discussion has stalled",
    "context": "If nobody replied, ask one narrower question."
  }
}
```

Before the timer fires, the outer orchestrator adds:

```bash
wechat-bro host --to "三人组" --prompt "If the workflow still feels abstract, use a very short flowchart at an appropriate moment. Do not post one just for demonstration."
```

Expected behavior:

1. the 600-second wake is superseded;
2. the same room agent/session runs immediately with the new guidance and superseded-plan context;
3. it may choose to remain silent now;
4. its new result installs the next continuation or ends hosting;
5. the old wake can never fire afterward.

## Acceptance criteria

1. Existing first-call `host` behavior remains backward compatible.
2. A second `host` call for a target with an active continuation is treated as an update, not an independent parallel host task.
3. Existing pending wakeup is superseded before the update task runs.
4. Same routed agent and same resumable session are used.
5. New prompt is injected as authoritative host guidance; old reason/context is labeled superseded planning context only.
6. Update prompt explicitly says that immediate outbound messaging is optional.
7. Worker result fully replaces the old continuation plan; absence of `next_action` ends proactive hosting.
8. Stale wake callbacks cannot execute after the update.
9. No extra public `guide`/`nudge`/`host-update` command is introduced.
10. Controlled E2E covers:
    - first `host` starts discussion;
    - worker creates pending wake;
    - second `host` arrives before due time;
    - old wake is superseded;
    - same session receives the added guidance;
    - worker returns a replacement `next_action` or none;
    - old timer never fires.
11. Documentation explains that `host` is a unified start-or-update control surface.

## Non-goals

- Multiple simultaneous host topics for the same contact/session.
- Separate resident hosting workers.
- A general-purpose task-update API unrelated to hosted discussions.
- Automatic merging of contradictory guidance beyond handing the latest authoritative prompt plus superseded context to the worker.
