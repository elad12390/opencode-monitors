# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] - 2026-10-29

### Fixed
- Fresh OpenCode 2 installs could fail to resolve conflicting OpenTUI peers. The package now uses the host-provided OpenTUI runtime without declaring conflicting optional peers.
- Clarified that output delivered to an agent can be saved in OpenCode session history, even though the popup's output buffer stays in memory.

### Added
- A package test exercises OpenCode's Bun/Arborist dependency resolver with the packed artifact.
- A demo of the popup and live monitor notifications, recorded in OpenCode with fictional log entries.

## [0.3.1] - 2026-10-29

### Changed
- Releases are published from GitHub Actions with npm trusted publishing and provenance, so each version on npm can be traced to the commit and workflow that built it. 0.3.0 was published by hand.
- Re-running the release workflow for a version that is already on npm skips the publish and still creates the GitHub release.

## [0.3.0] - 2026-10-29

First release as **opencode-monitors**, a fork of opencode-sentinel 0.2.0.

### Changed
- Renamed the package to `opencode-monitors` and the tools to `monitor`, `stop_monitor` and `list_monitors`. `sentinel_ping` and `sentinel_spike` are gone.
- `stop_monitor` takes a monitor's description or its ID; an ambiguous or unknown name stops nothing and lists what is running.
- Tool descriptions say what each tool does, why and when to use it, and how, in one paragraph each; results are plain sentences.
- The state file moved to `~/.local/state/opencode-monitors/monitors.json` (`OPENCODE_MONITORS_STATE_FILE`). Commands also get `MONITOR_SESSION_ID`; `SENTINEL_SESSION_ID` is still set.
- stderr is no longer written to `/tmp/sentinel-<id>-stderr.log`. It stays in memory, shows in `/monitors`, and its last lines are quoted when a command fails.

### Added
- `/monitors` popup (OpenCode 2): every monitor across projects with status, timing and line counts, its stdout and stderr, scrolling, kill with confirmation, and an All projects / This project filter.
- The agent is told whenever a monitor ends: clean exit, failure, a kill from `/monitors`, plugin unload, or an OpenCode restart or crash, with the command when a restart may be wanted.
- Restart recovery: monitors left running by a crashed OpenCode are killed (after checking the process still runs that command) and their sessions are told.
- Test suites: integration (real processes, plugin copies, crashes), `/monitors` rendering, performance, and an npm package install test.

### Fixed
- A catastrophic `filter` or `until` regex froze OpenCode; patterns now run in a worker with a 250 ms limit per line.
- A line with no newline grew memory without limit; lines are cut at 64K characters.
- After a flood or `until` stop, leftover output threw "Monitor not found" errors.
- OpenCode loads one plugin copy per open project; the copies now share one monitor list, so `/monitors` sees every monitor and one project's startup no longer kills another's monitors.

## [0.2.0] - 2026-10-16

### Added
- **OpenCode V2 support via a dual entrypoint** ([Issue #20](https://github.com/tsukimiya/opencode-sentinel/issues/20)). The plugin's default export now provides both `setup(ctx)` (V2 plugin API) and `server(input)` (V1 Hooks API), so a single package runs on OpenCode V1 and V2.
  - V2: tools are registered through `ctx.tool.transform`; notifications are delivered with `ctx.session.prompt({ delivery: "steer" })`.
  - V1: unchanged Hooks API; the V1 implementation is imported lazily by `server()` so a V2 host never has to resolve V1-only packages.

### Changed
- Monitor core (validation, spawn, batching, flood/`until` handling) is now shared by both entrypoints (`src/lib/core.ts`); the host-specific delivery is injected as a `deliver` function.
- `@opencode-ai/plugin` / `@opencode-ai/sdk` peer dependencies are marked optional — they are only required on the V1 path. A V2 host needs neither them nor `zod`.

### Test Coverage
- New `test/core.test.ts` covering monitor start/stop/list and `filter`/`until` regex validation.
- `test/watcher.test.ts` updated for the injected `deliver` contract.
- Live E2E on OpenCode V2 (2.0.29): tool registration, steer delivery on an idle session, and `sentinel_list` / `sentinel_stop`.

## [0.1.5] - 2026-08-02

### Added
- **`sentinel_monitor` now accepts optional `filter` and `until` regex arguments for condition-based notification** ([Issue #1](https://github.com/tsukimiya/opencode-sentinel/issues/1)).
  - `filter`: only lines matching the regex are notified; non-matching lines are silently dropped.
  - `until`: when a line matches (after `filter` if set), the line is notified and the monitor auto-stops — enables one-shot wait patterns (e.g. "wake me when CI finishes").
  - Invalid regex at start is reported and the monitor is not launched.

### Changed
- `sentinel_list` now includes `filter` / `until` in each entry when set.

### Test Coverage
- New tests covering filter-only notification, until auto-stop, filter+until composition, and list visibility of the new fields.

## [0.1.4] - 2026-07-28

### Added
- **`SENTINEL_SESSION_ID` environment variable is now injected into monitor child processes.** The monitor tool's `sessionID` is propagated to the spawned shell's env, so command strings can reference `$SENTINEL_SESSION_ID` and feed it back into downstream tools. This unblocks agmsg integration: `agmsg watch.sh "$SENTINEL_SESSION_ID" ...` uses it as the watermark persistence key, preventing lost watermarks on watcher restarts. ([PR #9](https://github.com/tsukimiya/opencode-sentinel/pull/9))

### Test Coverage
- New test asserting the spawned child process receives `SENTINEL_SESSION_ID` in its env.

## [0.1.3] - 2026-07-08

### Changed
- Aligned watcher tests with the parts route API (`client.session.prompt({ parts })`) and synced `.gitignore`. ([PR #7](https://github.com/tsukimiya/opencode-sentinel/pull/7))

### Fixed
- Deliver notifications via the session message route with host client config (uses the host's in-process fetch + baseUrl so the v2 client works in TUI mode where `serverUrl` is a dummy). ([8024603](https://github.com/tsukimiya/opencode-sentinel/commit/8024603))

## [0.1.2] - 2026-07-08

### Changed
- Portable dev setup without machine-specific paths. ([914356c](https://github.com/tsukimiya/opencode-sentinel/commit/914356c))
- Use v2 session API (`client.v2.session.prompt`) for steer delivery. ([7990295](https://github.com/tsukimiya/opencode-sentinel/commit/7990295))

## [0.1.1] - 2026-07-08

### Changed
- Corrected repository URL (tsukimiya), added homepage/bugs metadata. ([8320866](https://github.com/tsukimiya/opencode-sentinel/commit/8320866))
- Split README into English (`README.md`) and Japanese (`README_ja.md`). ([f0152ca](https://github.com/tsukimiya/opencode-sentinel/commit/f0152ca))

## [0.1.0] - 2026-07-07

### Added
- Initial release: OpenCode plugin for background process monitoring with steer-based real-time agent notifications.
- Tools: `sentinel_monitor`, `sentinel_stop`, `sentinel_list`, `sentinel_ping`, `sentinel_spike`.
- Features: 200ms batching, flood protection (100 lines/sec auto-kill), stderr separation, auto cleanup on session end.

[Unreleased]: https://github.com/elad12390/opencode-monitors/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/elad12390/opencode-monitors/releases/tag/v0.3.1
[0.3.0]: https://github.com/elad12390/opencode-monitors/releases/tag/v0.3.0
[0.2.0]: https://github.com/tsukimiya/opencode-sentinel/releases/tag/v0.2.0
[0.1.5]: https://github.com/tsukimiya/opencode-sentinel/releases/tag/v0.1.5
[0.1.4]: https://github.com/tsukimiya/opencode-sentinel/releases/tag/v0.1.4
[0.1.3]: https://github.com/tsukimiya/opencode-sentinel/releases/tag/v0.1.3
[0.1.2]: https://github.com/tsukimiya/opencode-sentinel/releases/tag/v0.1.2
[0.1.1]: https://github.com/tsukimiya/opencode-sentinel/releases/tag/v0.1.1
[0.1.0]: https://github.com/tsukimiya/opencode-sentinel/releases/tag/v0.1.0
