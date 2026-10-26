import { manager } from "./manager"
import { startWatcher, type Deliver } from "./watcher"
import { generateId, timestamp } from "./util"

export type { Deliver } from "./watcher"

export interface StartMonitorParams {
  command: string
  description: string
  filter?: string
  until?: string
  sessionID: string
  deliver: Deliver
  /** The project directory the monitor is started in. */
  directory?: string
  /** The plugin instance starting it; unloading that instance stops it. */
  owner?: string
}

/**
 * Shared monitor logic used by both the V1 and V2 tool adapters.
 * Validates the filter/until regexes, spawns the watched process and registers
 * it with the manager. Returns the tool result string shown to the model.
 */
export function startMonitor(params: StartMonitorParams): string {
  for (const [name, pattern] of [["filter", params.filter], ["until", params.until]] as const) {
    if (!pattern) continue
    try {
      new RegExp(pattern)
    } catch (e: any) {
      return `Did not start the monitor: the ${name} pattern ${JSON.stringify(pattern)} is not a valid JavaScript regex (${e.message}). Fix it and try again.`
    }
  }

  const id = generateId()
  const proc = startWatcher({
    id,
    command: params.command,
    sessionID: params.sessionID,
    deliver: params.deliver,
    manager,
    filter: params.filter,
    until: params.until,
  })
  manager.start({
    id,
    proc,
    description: params.description,
    command: params.command,
    startedAt: timestamp(),
    linesEmitted: 0,
    sessionID: params.sessionID,
    filter: params.filter,
    until: params.until,
    directory: params.directory,
    owner: params.owner,
    deliver: params.deliver,
  })
  const narrowing = [
    params.filter ? `only lines matching ${JSON.stringify(params.filter)}` : undefined,
    params.until ? `stopping after a line matches ${JSON.stringify(params.until)}` : undefined,
  ].filter(Boolean)
  return [
    `Started monitor ${id} "${params.description}": ${params.command}`,
    `Its new output lines will arrive as messages${narrowing.length ? ` (${narrowing.join(", ")})` : ""}, and you will be told when it ends.`,
    `Stop it with stop_monitor when you no longer need it.`,
  ].join("\n")
}

/** Stops the running monitor whose ID or description is `name`. */
export function stopMonitor(name: string): string {
  const wanted = name.trim()
  const running = manager.list()
  const byID = running.find((m) => m.id === wanted)
  const byDescription = running.filter((m) => m.description.trim().toLowerCase() === wanted.toLowerCase())
  const matches = byID ? [byID] : byDescription

  if (matches.length === 1) {
    const [monitor] = matches
    manager.stop(monitor.id)
    return `Stopped monitor ${monitor.id} "${monitor.description}" and killed its command.`
  }
  if (matches.length > 1) {
    return `${matches.length} running monitors are called "${wanted}"; nothing was stopped. Pass one of their IDs instead:\n${matches.map((m) => `- ${m.id}: ${m.command}`).join("\n")}`
  }
  if (running.length === 0) {
    return `No monitor is running, so there was nothing to stop.`
  }
  return `No running monitor has the ID or description "${wanted}"; nothing was stopped. Running now:\n${running.map((m) => `- ${m.id} "${m.description}"`).join("\n")}`
}

function age(startedAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function listMonitors(): string {
  const monitors = manager.list()
  if (monitors.length === 0) {
    return "No monitors are running."
  }
  const heading = monitors.length === 1 ? "1 monitor is running:" : `${monitors.length} monitors are running:`
  const entries = monitors.map((m) => {
    const details = [
      `running ${age(m.startedAt)}`,
      `${m.linesEmitted} line${m.linesEmitted === 1 ? "" : "s"} printed`,
      m.filter ? `filter ${JSON.stringify(m.filter)}` : undefined,
      m.until ? `until ${JSON.stringify(m.until)}` : undefined,
    ].filter(Boolean)
    return `- ${m.id} "${m.description}" (${details.join(", ")})\n  $ ${m.command}`
  })
  return [heading, ...entries].join("\n")
}
