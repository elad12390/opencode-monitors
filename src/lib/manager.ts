import type { ChildProcess } from "node:child_process"
import { LogBuffer, type LogLine, type LogStream } from "./logs"

/**
 * - running: the command is still going
 * - completed / failed: the command exited by itself, with code 0 / non-zero
 * - stopped: someone stopped it (the agent, the user, or the session ending)
 * - until: its `until` pattern matched
 * - flood: it printed more than the flood limit
 * - slow-filter: its filter/until pattern took too long on one line
 * - filter-error: its filter/until pattern could not run
 */
export type MonitorStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "until"
  | "flood"
  | "slow-filter"
  | "filter-error"

export type StopReason = Exclude<MonitorStatus, "running" | "completed" | "failed">

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

interface Record extends MonitorEntry {
  status: MonitorStatus
  endedAt?: string
  exitCode?: number | null
  signal?: string | null
  logs: LogBuffer
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

export interface MonitorInfo extends MonitorEntryPublic {
  sessionID: string
  status: MonitorStatus
  endedAt?: string
  exitCode?: number | null
  signal?: string | null
  pid?: number
}

/** Finished monitors kept for the /monitors view. */
export const MAX_FINISHED = 50

export class MonitorManager {
  private running = new Map<string, Record>()
  private finished = new Map<string, Record>()
  private listeners = new Set<(id: string) => void>()

  start(entry: MonitorEntry): string {
    const record: Record = Object.assign(entry, {
      status: "running" as const,
      logs: new LogBuffer(),
    })
    this.running.set(entry.id, record)
    this.changed(entry.id)
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

  private finish(record: Record, status: MonitorStatus): void {
    this.running.delete(record.id)
    record.status = status
    record.endedAt ??= new Date().toISOString()
    this.finished.set(record.id, record)
    while (this.finished.size > MAX_FINISHED) {
      this.finished.delete(this.finished.keys().next().value!)
    }
    this.changed(record.id)
  }

  /** Stops a running monitor. `reason` is recorded as its final status. */
  stop(id: string, reason: StopReason = "stopped"): void {
    const record = this.running.get(id)
    if (!record) {
      throw new Error(`Monitor not found: ${id}`)
    }
    this.kill(record)
    this.finish(record, reason)
  }

  /** Records that a monitor's process ended. A monitor that was stopped keeps its stop reason. */
  exited(id: string, code: number | null, signal: string | null): void {
    const record = this.running.get(id) ?? this.finished.get(id)
    if (!record) return
    record.exitCode = code
    record.signal = signal
    if (record.status === "running") {
      this.finish(record, code === 0 ? "completed" : "failed")
    } else {
      this.changed(id)
    }
  }

  get(id: string): MonitorEntry | undefined {
    return this.running.get(id)
  }

  /** Running monitors only. */
  list(): MonitorEntryPublic[] {
    return Array.from(this.running.values()).map((entry) => ({
      id: entry.id,
      description: entry.description,
      command: entry.command,
      startedAt: entry.startedAt,
      linesEmitted: entry.linesEmitted,
      filter: entry.filter,
      until: entry.until,
    }))
  }

  /** Running monitors, then recently finished ones, newest first in each group. */
  all(): MonitorInfo[] {
    const info = (record: Record): MonitorInfo => ({
      id: record.id,
      description: record.description,
      command: record.command,
      startedAt: record.startedAt,
      linesEmitted: record.linesEmitted,
      filter: record.filter,
      until: record.until,
      sessionID: record.sessionID,
      status: record.status,
      endedAt: record.endedAt,
      exitCode: record.exitCode,
      signal: record.signal,
      pid: record.proc.pid,
    })
    return [
      ...Array.from(this.running.values()).reverse().map(info),
      ...Array.from(this.finished.values()).reverse().map(info),
    ]
  }

  /** Recent output of a running or recently finished monitor. */
  logs(id: string, limit?: number): LogLine[] | undefined {
    return (this.running.get(id) ?? this.finished.get(id))?.logs.tail(limit)
  }

  appendLog(id: string, stream: LogStream, text: string): void {
    const record = this.running.get(id) ?? this.finished.get(id)
    if (!record) return
    record.logs.append(stream, text)
    this.changed(id)
  }

  incrementLines(id: string): void {
    const entry = this.running.get(id)
    if (entry) {
      entry.linesEmitted++
    }
  }

  /** Calls `listener` with a monitor's ID whenever its status or logs change. */
  onChange(listener: (id: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(id: string): void {
    for (const listener of this.listeners) listener(id)
  }

  /** Stops only the monitors owned by `sessionID`, leaving other sessions' monitors running. */
  disposeSession(sessionID: string): void {
    for (const record of Array.from(this.running.values())) {
      if (record.sessionID !== sessionID) continue
      this.kill(record)
      this.finish(record, "stopped")
    }
  }

  /** Stops every monitor and forgets them. Reserved for plugin unload. */
  dispose(): void {
    for (const record of this.running.values()) {
      this.kill(record)
    }
    this.running.clear()
    this.finished.clear()
  }
}

export const manager = new MonitorManager()
