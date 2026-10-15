import type { ChildProcess } from "node:child_process"

export interface MonitorEntry {
  id: string
  proc: ChildProcess
  description: string
  command: string
  startedAt: string
  linesEmitted: number
  sessionID: string
  filter?: string
  until?: string
}

export interface MonitorEntryPublic {
  id: string
  description: string
  command: string
  startedAt: string
  linesEmitted: number
  filter?: string
  until?: string
}

export class MonitorManager {
  private entries = new Map<string, MonitorEntry>()

  start(entry: MonitorEntry): string {
    this.entries.set(entry.id, entry)
    return entry.id
  }

  /** Sends SIGTERM to the entry's process group, ignoring an already-dead process. */
  private kill(entry: MonitorEntry): void {
    if (entry.proc.pid) {
      try {
        process.kill(-entry.proc.pid, "SIGTERM")
      } catch {
        // Process may already be dead
      }
    }
  }

  stop(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) {
      throw new Error(`Monitor not found: ${id}`)
    }
    this.kill(entry)
    this.entries.delete(id)
  }

  get(id: string): MonitorEntry | undefined {
    return this.entries.get(id)
  }

  list(): MonitorEntryPublic[] {
    return Array.from(this.entries.values()).map((entry) => ({
      id: entry.id,
      description: entry.description,
      command: entry.command,
      startedAt: entry.startedAt,
      linesEmitted: entry.linesEmitted,
      filter: entry.filter,
      until: entry.until,
    }))
  }

  incrementLines(id: string): void {
    const entry = this.entries.get(id)
    if (entry) {
      entry.linesEmitted++
    }
  }

  /** Stops only the monitors owned by `sessionID`, leaving other sessions' monitors running. */
  disposeSession(sessionID: string): void {
    for (const [id, entry] of this.entries) {
      if (entry.sessionID !== sessionID) continue
      this.kill(entry)
      this.entries.delete(id)
    }
  }

  /** Stops every monitor. Reserved for plugin unload. */
  dispose(): void {
    for (const entry of this.entries.values()) {
      this.kill(entry)
    }
    this.entries.clear()
  }
}

export const manager = new MonitorManager()
