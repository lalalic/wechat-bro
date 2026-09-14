# Unexpected WeChat logout in long-running daemon

## Problem

`wechat-bro` is intended to keep a user's authenticated WeChat Web session alive
inside a long-running local daemon. The daemon/service itself can remain healthy
and continuously emit browser heartbeats, while the WeChat account unexpectedly
becomes logged out.

This is not primarily a process-crash problem. During the observed incident:

- the PM2-managed `wechat-bro-orchestrator` process remained `online`;
- the daemon/browser continued emitting `heartbeat@browser`;
- the WeChat session had previously been logged in successfully;
- later the daemon emitted a fresh `scan` event and reported `loggedIn: false`;
- `npx wechat-bro status` and `send-text` calls timed out instead of quickly
  reporting that the authenticated session had been lost.

The expected product behavior is that a successful login should remain usable
for long-running maintainer/orchestrator operation unless WeChat itself requires
a fresh user confirmation. We need to understand why the session is being
logged out and make the login/session lifecycle robust.

## Objective

Investigate and fix unexpected loss of the authenticated WeChat Web session
while the daemon remains running.

The implementation should first determine the actual logout mechanism rather
than treating the symptom as a generic daemon crash. It should preserve an
already-authenticated session whenever technically possible, recover safely from
recoverable session/page failures, and clearly surface `login_required` when a
fresh QR/user confirmation is genuinely required.

## Investigation areas

At minimum inspect:

- WeChat Web cookies/session credentials and their rotation/expiry behavior;
- whether `cookies.json` persistence is complete and timely enough;
- whether restoring cookies loses session attributes or misses newly rotated
  credentials;
- login-state transitions in `wechat-bro.js` / `cli.js`;
- navigation/reload behavior that can invalidate the authenticated page while
  leaving the browser process alive;
- detached/stale frame incidents and whether they precede logout or are only a
  downstream symptom;
- whether heartbeat currently proves only browser liveness rather than
  authenticated WeChat-session liveness;
- any WeChat-side logout/kick/session-invalid response that can be detected and
  logged before the account falls back to QR login.

Likely relevant files include `src/cli.js`, `src/wechat-bro.js`,
`src/orchestrator.js`, cookie/session tests, and end-to-end lifecycle tests.

## Required behavior

1. A daemon that has successfully logged in must track authenticated-session
   health separately from process/browser heartbeat.
2. The implementation must log a useful reason/state transition when the
   WeChat session changes from logged-in to logged-out, when observable.
3. Recoverable page/session failures should recover automatically without
   requiring a manual PM2 restart or QR rescan.
4. Persisted session state should survive normal daemon/orchestrator restart when
   WeChat still considers the session valid.
5. If WeChat truly invalidates the session and requires fresh user confirmation,
   commands should fail fast with an explicit `login_required` / logged-out state
   rather than waiting for the generic command timeout.
6. Recovery must use bounded retry/backoff and must not enter a rapid restart or
   login loop.
7. Existing message routing and orchestrator behavior must continue to work
   after a successful automatic recovery.

## Non-goals

- Do not bypass WeChat/Tencent authentication or account-security controls.
- Do not add anti-detection, multi-login, multi-account, or session-forging
  behavior.
- Do not fake a logged-in state when WeChat requires fresh QR confirmation.
- Do not replace PM2 or redesign the service manager; PM2 process liveness is not
  the bug being fixed here.

## Reproduction / evidence from observed incident

Observed on 2026-09-14:

```text
PM2 orchestrator: online
browser: heartbeat@browser continues
prior state: authenticated and usable
later daemon state: scan event emitted / loggedIn=false
CLI status: timeout
CLI send-text: timeout
```

The worker should add deterministic tests for the session-state transitions it
changes, and where practical add an integration-style test that simulates loss
of authenticated page/session state while the daemon process itself remains
alive.

## Validation

At minimum run the repository's existing test suite plus new tests covering the
session/logout lifecycle. Report the root cause found, changed files, validation
commands/results, and any remaining case where a QR rescan is unavoidable.
