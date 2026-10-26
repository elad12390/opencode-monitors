// What the agent is told when a monitor ends for a reason it did not see
// itself. Ends the watcher already reports as they happen (until, flood, slow
// or failing filter) and ends the agent caused (stop_monitor) have no notice
// here.

export type EndReason =
  /** The command exited by itself. */
  | "exit"
  /** The agent stopped it with stop_monitor. */
  | "agent"
  /** The user killed it from /monitors. */
  | "user"
  /** Its session was deleted. */
  | "session"
  /** The plugin was unloaded or OpenCode shut down. */
  | "unload"
  /** OpenCode stopped without unloading the plugin (restart or crash). */
  | "restart"
  | "until"
  | "flood"
  | "slow-filter"
  | "filter-error"

/** Ends that get a notice from the manager. */
export const ANNOUNCED_ENDS: ReadonlySet<EndReason> = new Set(["exit", "user", "unload", "restart"])

export interface EndedMonitor {
  id: string
  description: string
  command: string
  status: string
  endReason?: EndReason
  exitCode?: number | null
  signal?: string | null
  endedAt?: string
}

const restartHint = (monitor: EndedMonitor) =>
  ` If you still need it, start it again with monitor (command: ${JSON.stringify(monitor.command)}).`

export function endNotice(monitor: EndedMonitor): string | undefined {
  const name = `[monitor:${monitor.id}] "${monitor.description}"`
  switch (monitor.endReason) {
    case "exit":
      if (monitor.status === "completed") {
        return `${name} finished: the command exited with code 0. It is no longer running.`
      }
      if (monitor.signal) {
        return `${name} ended: the command was killed by ${monitor.signal}. It is no longer running.${restartHint(monitor)}`
      }
      return `${name} ended: the command exited with code ${monitor.exitCode ?? "unknown"}. It is no longer running.${restartHint(monitor)}`
    case "user":
      return `${name} was killed by the user from /monitors. It is no longer running.`
    case "unload":
      return `${name} stopped because the monitors plugin was unloaded or OpenCode shut down. It is no longer running.${restartHint(monitor)}`
    case "restart":
      return `${name} stopped because OpenCode restarted${monitor.endedAt ? ` (noticed at ${monitor.endedAt})` : ""}. It is no longer running.${restartHint(monitor)}`
    default:
      return undefined
  }
}
