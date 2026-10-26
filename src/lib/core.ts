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
  if (params.filter) {
    try {
      new RegExp(params.filter)
    } catch (e: any) {
      return `Invalid filter regex: ${e.message}`
    }
  }
  if (params.until) {
    try {
      new RegExp(params.until)
    } catch (e: any) {
      return `Invalid until regex: ${e.message}`
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
  return `Monitor started: ${id}\nCommand: ${params.command}\nUse sentinel_stop to stop it. You will be told when it ends, including when OpenCode restarts.`
}

export function stopMonitor(id: string): string {
  try {
    manager.stop(id)
    return `Monitor ${id} stopped.`
  } catch (err: any) {
    return `Error: ${err.message}`
  }
}

export function listMonitors(): string {
  const monitors = manager.list()
  if (monitors.length === 0) {
    return "No monitors are currently running."
  }
  return monitors
    .map((m) => {
      let s = `[${m.id}] ${m.description}\n  command: ${m.command}\n  started: ${m.startedAt}\n  lines: ${m.linesEmitted}`
      if (m.filter) s += `\n  filter: ${m.filter}`
      if (m.until) s += `\n  until: ${m.until}`
      return s
    })
    .join("\n\n")
}
