# WeChat Bro Agent Rules

## Release and Runtime

- After pushing a release, verify that the new version is actually available from npm before restarting any runtime process. For example: `npm view wechat-bro version`.
- Restart the daemon and orchestrator using the published npm package via `npx wechat-bro ...`.
- Never start or restart the daemon or orchestrator from a local repository checkout, worktree, or `node src/cli.js` path.
- Runtime version checks must use `wechat-bro status`; confirm the reported `version`, `orchestrator.version`, and `daemon.version` match the npm version before considering the restart complete.
