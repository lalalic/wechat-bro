# WeChat Web management UI

## Objective
Configure WeChat-bro directly in desktop WeChat Web without another dashboard;
filehelper remains the remote/phone management surface.

## Features
- Floating compact AI launcher and style-isolated panel.
- Chats: contact/room selection, Agent, maintainer/assistant mode, watch/unwatch,
  pause/resume.
- Agents: read/edit effective Agent Markdown, override bundled defaults on Save,
  do not directly change harness/routing metadata.
- Rules/Memory: load/save global and contact-scoped Markdown.
- Reuse the existing orchestrator and reload-on-dispatch workflow.
- No messages are sent by UI management operations.

## Trust boundary
- Inject only within daemon-owned https://wx.qq.com page.
- Node controller owns filesystem; browser gets strictly allowlisted operations.
- Reject arbitrary paths, symlinks, excessive text, invalid commands and stale writes.
- Private per-page random binding nonce; genuine user-click requirement.
- Preserve cookies, WebHelm profile and other Tab Groups.

## Verification
- Offline tests: routing, content saves, default overrides, concurrency,
  symlink and path validation, secret and origin rejection.
- Live Chrome test: mount, real CDP user clicks, catalog/watch/save, repeated
  injection and Session teardown.
- npm test and full Orchestrator E2E PASS; review-fix-review before merge.
