// Presentation logic for the /monitors popup, kept free of OpenTUI so it can be
// tested directly.

export type MonitorStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "until"
  | "flood"
  | "slow-filter"
  | "filter-error"

export interface Monitor {
  id: string
  description: string
  command: string
  startedAt: string
  endedAt?: string
  linesEmitted: number
  sessionID: string
  status: MonitorStatus
  exitCode?: number | null
  signal?: string | null
  endReason?: string
  /** The project directory it was started in. */
  directory?: string
  /** Read back after an OpenCode restart; its output was not kept. */
  restored?: boolean
  pid?: number
  filter?: string
  until?: string
}

export type Scope = "all" | "project"

/** The monitors a scope shows: all of them, or those started in `directory`. */
export function inScope(monitors: readonly Monitor[], scope: Scope, directory: string | undefined): Monitor[] {
  if (scope === "all" || !directory) return [...monitors]
  return monitors.filter((m) => m.directory === directory)
}

/** The last path segment, used as a short project name. */
export function projectName(directory: string | undefined): string {
  if (!directory) return "unknown"
  const parts = directory.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? directory
}

export interface LogLine {
  at: string
  stream: "stdout" | "stderr"
  text: string
}

export type Tone = "running" | "success" | "error" | "warning" | "muted"

export interface StatusLabel {
  icon: string
  text: string
  tone: Tone
}

export function statusLabel(monitor: Monitor, mono = false): StatusLabel {
  switch (monitor.status) {
    case "running":
      return { icon: mono ? "*" : "●", text: "running", tone: "running" }
    case "completed":
      return { icon: mono ? "+" : "✓", text: "done", tone: "success" }
    case "failed":
      return {
        icon: mono ? "x" : "✗",
        text: monitor.signal ? `killed (${monitor.signal})` : `failed (exit ${monitor.exitCode ?? "?"})`,
        tone: "error",
      }
    case "stopped": {
      const icon = mono ? "-" : "■"
      switch (monitor.endReason) {
        case "user":
          return { icon, text: "killed by you", tone: "muted" }
        case "agent":
          return { icon, text: "stopped by agent", tone: "muted" }
        case "session":
          return { icon, text: "session ended", tone: "muted" }
        case "unload":
          return { icon: mono ? "!" : "▲", text: "plugin unloaded", tone: "warning" }
        case "restart":
          return { icon: mono ? "!" : "▲", text: "OpenCode restarted", tone: "warning" }
        default:
          return { icon, text: "stopped", tone: "muted" }
      }
    }
    case "until":
      return { icon: mono ? "+" : "✓", text: "matched until", tone: "success" }
    case "flood":
      return { icon: mono ? "!" : "▲", text: "stopped: flood", tone: "warning" }
    case "slow-filter":
      return { icon: mono ? "!" : "▲", text: "stopped: slow filter", tone: "warning" }
    case "filter-error":
      return { icon: mono ? "!" : "▲", text: "stopped: filter error", tone: "warning" }
  }
}

/** A readable message for an Error, an RPC failure object ({ type, message }) or anything else. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    const { type, message } = error as { type?: unknown; message?: unknown }
    if (typeof message === "string") return typeof type === "string" ? `${message} (${type})` : message
    try {
      return JSON.stringify(error)
    } catch {}
  }
  return String(error)
}

/** "4s", "3m 12s", "2h 05m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

/** How long a running monitor has been going, or how long ago a finished one ended. */
export function timing(monitor: Monitor, now: number): string {
  if (monitor.status === "running") return formatDuration(now - Date.parse(monitor.startedAt))
  const ended = monitor.endedAt ? Date.parse(monitor.endedAt) : now
  return `${formatDuration(now - ended)} ago`
}

export function formatCount(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`
}

/** "2 running · 3 finished". */
export function summary(monitors: readonly Monitor[]): string {
  const running = monitors.filter((m) => m.status === "running").length
  const finished = monitors.length - running
  if (monitors.length === 0) return "none yet"
  if (finished === 0) return `${running} running`
  if (running === 0) return `${finished} finished`
  return `${running} running · ${finished} finished`
}

/** Local wall-clock time of an ISO timestamp, "14:03:27". */
export function clock(iso: string): string {
  const date = new Date(iso)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
}

/** Shortens `text` to `width` characters, ending in an ellipsis when cut. */
export function fit(text: string, width: number, mono = false): string {
  if (width <= 0) return ""
  if (text.length <= width) return text
  const ellipsis = mono ? "..." : "…"
  if (width <= ellipsis.length) return text.slice(0, width)
  return text.slice(0, width - ellipsis.length) + ellipsis
}

/**
 * Keeps the selection on the same monitor when the list refreshes, and inside
 * the list when that monitor disappears.
 */
export function reselect(
  monitors: readonly Monitor[],
  previousID: string | undefined,
  previousIndex: number,
): number {
  if (monitors.length === 0) return 0
  if (previousID) {
    const index = monitors.findIndex((m) => m.id === previousID)
    if (index !== -1) return index
  }
  return Math.min(Math.max(0, previousIndex), monitors.length - 1)
}

/**
 * Which slice of the log to show: the newest `rows` lines, moved back by
 * `scrollBack` lines. Returns the clamped scrollBack alongside the slice.
 */
export function logWindow<T>(lines: readonly T[], rows: number, scrollBack: number) {
  const maxBack = Math.max(0, lines.length - rows)
  const back = Math.min(Math.max(0, scrollBack), maxBack)
  const end = lines.length - back
  return { lines: lines.slice(Math.max(0, end - rows), end), scrollBack: back, maxBack }
}
