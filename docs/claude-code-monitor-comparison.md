# opencode-monitors vs Claude Code's Monitor

**Short answer:** for the everyday job, opencode-monitors is comparable. The agent starts a command in the background, each output line comes back to the session, and an idle session wakes up to react. Claude Code goes further on safety and lifecycle: watches have deadlines, obey your shell permission rules and stop with the subagent that started them. Claude Code also has two more ways to start a watch, a WebSocket feed and plugin-declared monitors. opencode-monitors has three extras Claude Code doesn't document: a built-in line filter, auto-stop on a matching line, and flood protection.

Sources: Claude Code [Tools reference: Monitor tool](https://code.claude.com/docs/en/tools-reference#monitor-tool), [Plugin manifest reference: monitors](https://code.claude.com/docs/en/plugins/manifest-reference#monitors), [Plugin components](https://code.claude.com/docs/en/plugins/components) and [What's new, week 15 2026](https://code.claude.com/docs/en/whats-new/2026-w15). opencode-monitors behavior is read from `src/` and measured by `bun run test:perf`. Checked on 2026-10-26 against Claude Code docs current that day and OpenCode 2.1.4.

Legend: ✅ supported · ⚠️ partly · ❌ missing · ➖ not documented

## How a watch starts

| Capability | Claude Code Monitor | opencode-monitors | Notes |
|---|---|---|---|
| Agent starts a background command and gets each output line | ✅ | ✅ | `Monitor` with `command`; `monitor` with `command` |
| Agent connects to a WebSocket feed directly | ✅ | ❌ | Claude Code: `ws` input with `url` and `protocols`. Each text message is one event, binary frames become a placeholder, and messages over 1 MiB or a socket close end the watch |
| Plugin declares monitors that start on their own | ✅ | ❌ | Claude Code: `monitors/monitors.json`, with `when: "always"` (session start and plugin reload) or `"on-skill-invoke:<skill>"` |
| Short description shown to the user | ✅ | ✅ | opencode-monitors requires `description` |

## What the agent receives

| Capability | Claude Code Monitor | opencode-monitors | Notes |
|---|---|---|---|
| Each stdout line reaches the session | ✅ one message per event | ⚠️ grouped | opencode-monitors collects lines for 200 ms and sends them as one message |
| Wakes an idle session and interjects while it works | ✅ | ✅ | opencode-monitors uses `delivery: "steer"` on OpenCode V2 |
| Built-in line filter | ➖ the agent filters inside its script | ✅ | `filter` regex |
| Stop automatically on a matching line | ➖ | ✅ | `until` regex, for "tell me when CI finishes" |
| Notice when the command exits | ➖ | ✅ | Clean exits, failures (exit code or signal) and a kill from `/monitors` are all reported, after the last output |
| Notice when OpenCode restarts or crashes | ➖ | ✅ | Monitors are recorded in `~/.local/state/opencode-monitors/monitors.json`. On the next start, opencode-monitors kills leftover processes and tells each session its monitor stopped, with the command to start it again |
| stderr | ➖ | ⚠️ | stderr is not sent as it arrives; a failure notice quotes its last 5 lines, and `/monitors` shows all of it |
| Flood protection | ➖ | ✅ | opencode-monitors stops a monitor above 100 lines/s and says so |

## How a watch ends

| Capability | Claude Code Monitor | opencode-monitors | Notes |
|---|---|---|---|
| Deadline | ✅ 5 min default, 30 min max, 10 min in `-p` runs, with one notice at the deadline | ❌ | opencode-monitors monitors run until stopped, the command exits or the session is deleted |
| Agent or user cancels it | ✅ ask Claude, or `TaskStop` | ✅ | `stop_monitor` |
| Stops when the session ends | ✅ | ⚠️ | opencode-monitors stops on `session.deleted`, and unloading the plugin in a project stops that project's monitors (with a notice); a session that merely goes idle keeps its monitors |
| Stops with the subagent that started it | ✅ | ❌ | opencode-monitors only ties monitors to the session ID that started them |
| UI to see and stop watches | ✅ task panel and `/tasks` | ✅ | `/monitors` popup: status, logs, kill, filter by project |

## Safety and limits

| Capability | Claude Code Monitor | opencode-monitors | Notes |
|---|---|---|---|
| Obeys your shell permission rules | ✅ same rules as Bash, and the auto-mode classifier reviews it | ❌ | opencode-monitors runs the command directly, so OpenCode `shell` allow/deny rules don't apply |
| Approval prompt for network sources | ✅ WebSocket prompt; private, link-local and cloud-metadata addresses denied | ➖ | Not applicable until opencode-monitors has a WebSocket source |
| Memory cap | ✅ Linux/WSL `CLAUDE_CODE_TOOL_MEMORY_LIMIT` | ❌ | |
| Windows | ✅ with Git Bash | ❌ untested | opencode-monitors kills process groups with `process.kill(-pid)`, which Windows doesn't support |

## Measured performance (opencode-monitors only)

Numbers from `bun run test:perf` on an M4 Pro MacBook Pro, Bun 1.4.3. "Latency" is the time from a line being written to the session receiving it.

| Scenario | Result |
|---|---|
| 10 lines/s | All 20 lines in order. Latency p50 100 ms, p95 201 ms, max 201 ms |
| 50 lines/s | All 100 lines in order, in 10 messages of 10 lines. p95 200 ms |
| 50 lines/s through a `filter` | Every other line kept, in order. p95 200 ms |
| Burst of 90 lines, then the command exits | One message, under 1 ms, because exit sends the batch immediately |
| Flood (5,000 lines as fast as possible) | Stopped after 100 lines, process gone within 23 ms |
| 50 monitors at 5 lines/s | All 750 lines delivered. p95 200 ms, p99 217 ms. Event loop lag p99 2.6 ms. 2.9% of one core |
| 20 idle monitors | 0.2% of one core |
| Start 100 monitors, then stop them | 0.5 ms per start; every process gone 12 ms after stopping |
| 32 MB written with no newline | One line, cut at 64K characters, reaches the agent. Memory grows by 2 MB; longest stall 1 ms |
| Filter `(a+)+$` on a 41-character line | The monitor stops with a notice after 250 ms. The server never blocks (longest stall 1 ms) |

Two of these were fixed after the suite first ran. Before the fixes, the 32 MB line grew memory by 30 MB and stalled the server for 228 ms, and the `(a+)+$` filter froze the whole OpenCode server for 304 ms on a 27-character line (each extra character doubles that). Filters now run in a worker thread with a 250 ms limit per line, and lines are capped at 64K characters.

The 200 ms floor on latency is the batching window, by design. Claude Code delivers each event as its own message; opencode-monitors trades up to 200 ms of delay for far fewer messages under load.

Claude Code publishes no comparable numbers, so this section describes opencode-monitors only.

## What it would take to close the gaps

In rough order of value:

1. **Permission rules.** Call `ctx.permission.assert` with the `shell` action before starting the command, so deny and ask rules apply.
2. **Deadlines.** Add a `timeout_ms` input (default 5 min, max 30 min) and send one notice when it fires.
3. **Subagent cleanup.** Stop a subagent's monitors when its session finishes.
4. **Plugin-declared monitors.** Read a monitors list from plugin config and start them at session start.
5. **WebSocket source.** Accept a `ws` input with the same limits and approval prompt as Claude Code.
