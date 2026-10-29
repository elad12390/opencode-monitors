# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Set up

You need [Bun](https://bun.sh) 1.3 or later.

```bash
bun install
bun run typecheck
bun run test
```

## Before you open a pull request

Run what CI runs:

```bash
bun run typecheck
bun run test
bun run test:integration
bun run test:tui
bun run test:package
bun run test:perf
```

- Test behavior, not internals: start real processes where you can, and drive the `/monitors` popup with key presses through OpenTUI's test renderer.
- Tool descriptions live in `src/tools.ts`, shared by the OpenCode 1 and 2 plugins. Keep each one a single short paragraph that says what the tool does, why and when to use it, and how; `test/tool-descriptions.test.ts` checks this.
- Add a line to the `Unreleased` section of `CHANGELOG.md` for anything a user would notice.

## How the code fits together

- `src/index.ts` is the plugin entry for both OpenCode 1 (`server`) and 2 (`setup`). `src/v2.ts` registers the tools and the `monitors` RPC.
- `src/lib/` holds the monitor engine: `watcher.ts` runs a command and batches its lines, `manager.ts` tracks every monitor (one shared instance per OpenCode process), `recovery.ts` handles restarts.
- `src/tui.tsx` and `src/tui/` are the `/monitors` popup. The npm package ships it prebuilt as `dist/tui.js` (`bun run build`).

## Releases

Maintainers release by bumping `version` in `package.json`, moving the `Unreleased` changelog entries under the new version, and pushing a matching tag such as `v0.3.1`. The Release workflow runs CI, publishes to npm with provenance through npm trusted publishing, and creates the GitHub release.
