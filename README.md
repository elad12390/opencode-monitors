# OpenCode Sentinel

A Monitor plugin for [OpenCode](https://opencode.ai) — background process monitoring with real-time agent notifications via steer delivery.

## Features

- **Process Monitoring**: Run any shell command in the background; each stdout line is delivered to the agent as a real-time steer notification
- **Parallel Monitors**: Run multiple monitors simultaneously
- **200ms Batching**: High-frequency output is batched at 200ms intervals to prevent flooding
- **Flood Protection**: Auto-kills monitors exceeding 100 lines/second
- **stderr Separation**: stderr is logged to `/tmp/sentinel-{id}-stderr.log`
- **Auto Cleanup**: All processes are terminated on session end or plugin unload

## Compatibility

opencode-sentinel supports both OpenCode **V1** and **V2** from a single package via a dual entrypoint.

| OpenCode | Plugin entrypoint | Status |
|---|---|---|
| V1 `>=1.18.29` | object form: `server(input)` | Supported |
| V2 `2.0.x` | object form: `setup(ctx)` | Supported |

The default export declares both `setup` (V2) and `server` (V1). On V1 hosts the V1 implementation is imported lazily, so no V2-only packages are needed; on V2 hosts neither the V1 packages (`@opencode-ai/plugin`, `@opencode-ai/sdk`) nor `zod` are needed.

> **Note:** OpenCode V1 hosts older than 1.18.29 expect a **function** default export and are not supported by 0.2.0. If you are on such a version, stay on 0.1.x or upgrade OpenCode.

## Installation

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-sentinel"]
}
```

Or install via file path:

```json
{
  "plugin": ["file:///path/to/opencode-sentinel/src/index.ts"]
}
```

Or via CLI:

```bash
opencode plugin opencode-sentinel
```

## Usage

### Log Monitoring

Just ask the agent in natural language:

```
Monitor /var/log/app.log for ERROR lines using sentinel_monitor
```

The agent will call the appropriate tools:

| Tool | Description |
|------|-------------|
| `sentinel_monitor` | Start monitoring (command + description label) |
| `sentinel_stop` | Stop a monitor by ID |
| `sentinel_list` | List all running monitors |
| `sentinel_ping` | Health check — returns "pong" |
| `sentinel_spike` | Spike test — 3-second delayed steer delivery (V1 only) |

### Important: grep requires `--line-buffered`

When piping to grep, you **must** use `--line-buffered`:

```
✅ tail -f /var/log/app.log | grep --line-buffered ERROR
❌ tail -f /var/log/app.log | grep ERROR
```

Without `--line-buffered`, grep buffers output and lines won't arrive in real-time.

### Filtering Output (filter)

Pass a JavaScript regex to `filter` to receive only matching lines:

```
sentinel_monitor with:
  command: tail -f /var/log/app.log | grep --line-buffered -E "(ERROR|WARN)"
  filter: "ERROR"
```

Only ERROR lines arrive as notifications; WARN lines are silently dropped.

### One-Shot Wait (until)

Use `until` to auto-stop the monitor when a matching line appears — ideal for "wake me when CI finishes" patterns without sleep polling:

```
sentinel_monitor with:
  command: gh run watch <run-id>
  until: "(completed|failed)"
```

When `until` matches, the line is delivered and the monitor is terminated automatically. Combine with `filter` to narrow the stream first:

```
sentinel_monitor with:
  command: tail -f build.log
  filter: "(error|fatal)"
  until: "BUILD (SUCCESS|FAILED)"
```

## steer vs queue

Sentinel uses `delivery: "steer"` for agent notifications. Here's how it differs from `"queue"`:

| Mode | Behavior |
|------|----------|
| **steer** (used by sentinel) | Immediately wakes idle sessions. During active runs, messages are promoted between provider turns. No streaming interruption. |
| **queue** | Messages are queued until the run completes, then delivered on the next user input. Unsuitable for real-time monitoring. |

Why steer:
- **Real-time responsiveness**: Instant wake on idle sessions ensures prompt log monitoring
- **No streaming disruption**: LLM responses are not interrupted; notifications are picked up at turn boundaries
- **No queue buildup**: Avoids notification backlog during long-running tasks

## Limitations

- **Orphaned Processes**: If OpenCode is killed via SIGKILL (bypassing the dispose hook), monitored processes may remain. Normal shutdown via dispose cleans up all processes.
- **No Mid-Stream Interruption**: During LLM response streaming, steer notifications are not processed until the current turn completes. Idle sessions respond within 500ms.

## Tech Stack

- TypeScript (strict)
- OpenCode V2 plugin API (`setup(ctx)`) and V1 Hooks API (`server`)
- @opencode-ai/plugin / @opencode-ai/sdk/v2 (V1 path only)
- Bun / Node.js compatible

## License

MIT

---

[日本語版はこちら](README_ja.md)
