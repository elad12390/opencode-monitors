import type { ChildProcess } from "node:child_process"
import { LogBuffer, type LogLine, type LogStream } from "./logs"
import { ANNOUNCED_ENDS, endNotice, type EndReason } from "./notices"
import type { MonitorStore, NoticeState, StoredMonitor } from "./state"

/** Delivers a notification string to the monitored session. */
export type Deliver = (text: string) => Promise<void>

/**
 * - running: the command is still going
 * - completed / failed: the command exited by itself, with code 0 / non-zero
 * - stopped: it was stopped; `endReason` says by whom or why
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
  proc?: ChildProcess
  description: string
  command: string
  startedAt: string
  linesEmitted: number
  sessionID: string
  filter?: string
  until?: string
  /** The project directory the monitor was started in. */
  directory?: string
  /** The plugin instance that started it; unloading that instance stops it. */
  owner?: string
  /** How to reach the monitor's session. */
  deliver?: Deliver
}

interface Record extends MonitorEntry {
  status: MonitorStatus
  endedAt?: string
  exitCode?: number | null
  signal?: string | null
  endReason?: EndReason
  notice?: NoticeState
  /** Recovered from the state file after a restart; its output was not kept. */
  restored?: boolean
  pid?: number
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
  endReason?: EndReason
  directory?: string
  restored?: boolean
  pid?: number
}

/** Finished monitors kept for the /monitors view. */
export const MAX_FINISHED = 50

/** Waits before each attempt to tell the agent how a monitor ended. */
export const NOTICE_RETRY_DELAYS_MS = [0, 1_000, 3_000]

export class MonitorManager {
  /** Marks the state-file records this manager owns. */
  readonly token = crypto.randomUUID()
  private running = new Map<string, Record>()
  private finished = new Map<string, Record>()
  private listeners = new Set<(id: string) => void>()
  private store?: MonitorStore

  /** Starts writing monitors to `store`, so their end can be reported after a restart. */
  persistTo(store: MonitorStore | undefined): void {
    this.store = store
    this.persist()
  }

  start(entry: MonitorEntry): string {
    const record: Record = Object.assign(entry, {
      status: "running" as const,
      pid: entry.proc?.pid,
      logs: new LogBuffer(),
    })
    this.running.set(entry.id, record)
    this.persist()
    this.changed(entry.id)
    return entry.id
  }

  /** Sends SIGTERM to the entry's process group, ignoring an already-dead process. */
  private kill(record: Record): void {
    const pid = record.proc?.pid ?? record.pid
    if (pid) {
      try {
        process.kill(-pid, "SIGTERM")
      } catch {
        // Process may already be dead
      }
    }
  }

  private finish(record: Record, status: MonitorStatus, endReason: EndReason): void {
    this.running.delete(record.id)
    record.status = status
    record.endReason = endReason
    record.endedAt ??= new Date().toISOString()
    this.finished.set(record.id, record)
    while (this.finished.size > MAX_FINISHED) {
      this.finished.delete(this.finished.keys().next().value!)
    }
    if (ANNOUNCED_ENDS.has(endReason)) record.notice = "pending"
    this.persist()
    this.changed(record.id)
    if (record.notice === "pending") void this.announce(record.id)
  }

  /**
   * Stops a running monitor. `status` is its final status; `endReason` says
   * who stopped it, and decides whether the agent is told (see notices.ts).
   */
  stop(id: string, status: StopReason = "stopped", endReason?: EndReason): void {
    const record = this.running.get(id)
    if (!record) {
      throw new Error(`Monitor not found: ${id}`)
    }
    this.kill(record)
    this.finish(record, status, endReason ?? (status === "stopped" ? "agent" : status))
  }

  /** Records that a monitor's process ended. A monitor that was stopped keeps its stop reason. */
  exited(id: string, code: number | null, signal: string | null): void {
    const record = this.running.get(id) ?? this.finished.get(id)
    if (!record) return
    record.exitCode = code
    record.signal = signal
    if (record.status === "running") {
      this.finish(record, code === 0 ? "completed" : "failed", "exit")
    } else {
      this.persist()
      this.changed(id)
    }
  }

  /**
   * Tells the monitor's session how it ended, retrying a few times. Uses the
   * monitor's own delivery unless `deliver` is given (after a restart the
   * monitor has none).
   */
  async announce(id: string, deliver?: Deliver, delays = NOTICE_RETRY_DELAYS_MS): Promise<boolean> {
    const record = this.finished.get(id)
    const send = deliver ?? record?.deliver
    const text = record && endNotice(record)
    if (!record || record.notice !== "pending" || !send || !text) return false
    for (const delay of delays) {
      if (delay > 0) await Bun.sleep(delay)
      if (record.notice !== "pending") return record.notice === "sent"
      try {
        await send(text)
        record.notice = "sent"
        this.persist()
        return true
      } catch (err) {
        console.error(`[sentinel] could not tell the agent how ${id} ended:`, err)
      }
    }
    record.notice = "dropped"
    this.persist()
    return false
  }

  /** Finished monitors whose end the agent has not been told yet. */
  pendingNotices(directory?: string): MonitorInfo[] {
    return Array.from(this.finished.values())
      .filter((r) => r.notice === "pending")
      .filter((r) => !directory || !r.directory || r.directory === directory)
      .map((r) => this.info(r))
  }

  has(id: string): boolean {
    return this.running.has(id) || this.finished.has(id)
  }

  /** Adds a finished monitor read back from the state file. */
  restore(stored: StoredMonitor): void {
    if (this.has(stored.id) || stored.status === "running") return
    const { ownerPid: _ownerPid, ownerToken: _ownerToken, ...fields } = stored
    this.finished.set(stored.id, { ...fields, restored: true, logs: new LogBuffer() })
    while (this.finished.size > MAX_FINISHED) {
      this.finished.delete(this.finished.keys().next().value!)
    }
    this.changed(stored.id)
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

  private info(record: Record): MonitorInfo {
    return {
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
      endReason: record.endReason,
      directory: record.directory,
      restored: record.restored,
      pid: record.proc?.pid ?? record.pid,
    }
  }

  /** Running monitors, then recently finished ones, newest first in each group. */
  all(): MonitorInfo[] {
    return [
      ...Array.from(this.running.values()).reverse().map((r) => this.info(r)),
      ...Array.from(this.finished.values()).reverse().map((r) => this.info(r)),
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

  private persist(): void {
    if (!this.store) return
    const records: StoredMonitor[] = [...this.running.values(), ...this.finished.values()].map((r) => ({
      id: r.id,
      description: r.description,
      command: r.command,
      sessionID: r.sessionID,
      directory: r.directory,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      status: r.status,
      endReason: r.endReason,
      exitCode: r.exitCode,
      signal: r.signal,
      pid: r.proc?.pid ?? r.pid,
      filter: r.filter,
      until: r.until,
      linesEmitted: r.linesEmitted,
      notice: r.notice,
      ownerPid: process.pid,
      ownerToken: this.token,
    }))
    try {
      this.store.save(records)
    } catch (err) {
      console.error("[sentinel] could not save monitor state:", err)
    }
  }

  /** Stops only the monitors owned by `sessionID`, leaving other sessions' monitors running. */
  disposeSession(sessionID: string): void {
    for (const record of Array.from(this.running.values())) {
      if (record.sessionID !== sessionID) continue
      this.kill(record)
      this.finish(record, "stopped", "session")
    }
  }

  /** Stops the monitors one plugin instance started, and tells their sessions. */
  disposeOwner(owner: string): void {
    for (const record of Array.from(this.running.values())) {
      if (record.owner !== owner) continue
      this.kill(record)
      this.finish(record, "stopped", "unload")
    }
  }

  /** Stops every monitor and forgets them, without notices. Used by the V1 plugin and tests. */
  dispose(): void {
    for (const record of this.running.values()) {
      this.kill(record)
    }
    this.running.clear()
    this.finished.clear()
    this.persist()
  }
}

/**
 * The one manager for this OpenCode process. OpenCode loads a separate copy
 * of the plugin for every open project (and again on every reload), so a
 * plain module-level instance would give each copy its own list: /monitors
 * would miss monitors started elsewhere, and one copy's restart recovery would
 * kill another copy's monitors. Keeping it on globalThis shares it. Bump the
 * version when the manager's shape changes, so a reloaded copy with new code
 * does not adopt an old instance.
 */
const MANAGER_KEY = Symbol.for("opencode-sentinel.manager.v1")
export const manager: MonitorManager = ((globalThis as any)[MANAGER_KEY] ??= new MonitorManager())
