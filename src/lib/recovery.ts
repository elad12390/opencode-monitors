import type { Deliver, MonitorManager } from "./manager"
import type { MonitorStore, StoredMonitor } from "./state"

/** Waits after plugin setup before telling sessions, so OpenCode can take prompts again. */
export const RECOVERY_NOTICE_DELAY_MS = 2_000

function ps(pid: number, fields: string): string | undefined {
  const result = Bun.spawnSync(["ps", "-ww", "-o", fields, "-p", String(pid)])
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}

/** Whether `pid` is a running OpenCode process (and not an unrelated process that reused the PID). */
export function isOpenCodeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return /opencode/i.test(ps(pid, "command=") ?? "")
}

/**
 * Kills a monitor's process group left behind by a dead OpenCode, but only
 * when the PID still leads its own group and runs the monitor's command, so
 * a reused PID is never killed.
 */
export function killOrphan(record: StoredMonitor): boolean {
  if (!record.pid) return false
  const line = ps(record.pid, "pgid=,command=")
  if (!line) return false
  const [pgid, ...command] = line.split(/\s+/)
  const expected = record.command.trim().slice(0, 60)
  if (Number(pgid) !== record.pid || !command.join(" ").includes(expected)) return false
  try {
    process.kill(-record.pid, "SIGTERM")
    return true
  } catch {
    return false
  }
}

/**
 * Brings monitors from the state file into this process:
 * - a monitor still marked running whose OpenCode is gone was stopped by the
 *   restart; its leftover process is killed and its session will be told
 * - finished monitors of a gone OpenCode come back as history for /monitors
 * - monitors owned by a running OpenCode, including this one, are left alone:
 *   their owner is still watching them
 *
 * Returns the IDs of monitors that ended in the restart.
 */
export function recoverMonitors(options: {
  manager: MonitorManager
  store: MonitorStore
  isOwnerAlive?: (pid: number) => boolean
  killOrphan?: (record: StoredMonitor) => boolean
  now?: () => Date
}): string[] {
  const isOwnerAlive = options.isOwnerAlive ?? isOpenCodeAlive
  const kill = options.killOrphan ?? killOrphan
  const now = options.now ?? (() => new Date())
  const ended: string[] = []

  const records = options.store
    .read()
    .filter((record) => !options.manager.has(record.id))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))

  for (const record of records) {
    if (record.ownerPid === process.pid || isOwnerAlive(record.ownerPid)) continue
    if (record.status === "running") {
      kill(record)
      options.manager.restore({
        ...record,
        status: "stopped",
        endReason: "restart",
        endedAt: now().toISOString(),
        notice: "pending",
      })
      ended.push(record.id)
    } else {
      options.manager.restore(record)
    }
  }
  options.manager.persistTo(options.store)
  return ended
}

/**
 * Tells sessions in `directory` about monitors whose end they have not heard
 * of yet, after a short delay. Each plugin instance calls this for its own
 * project, so a notice waits until its project is open in OpenCode.
 */
export function announcePending(options: {
  manager: MonitorManager
  directory?: string
  deliverTo: (sessionID: string) => Deliver
  delayMs?: number
}): () => void {
  const timer = setTimeout(() => {
    for (const monitor of options.manager.pendingNotices(options.directory)) {
      void options.manager.announce(monitor.id, options.deliverTo(monitor.sessionID))
    }
  }, options.delayMs ?? RECOVERY_NOTICE_DELAY_MS)
  return () => clearTimeout(timer)
}
