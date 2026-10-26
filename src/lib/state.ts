import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { MonitorStatus } from "./manager"
import type { EndReason } from "./notices"

/**
 * - pending: the agent still has to be told how the monitor ended
 * - sent: it was told
 * - dropped: telling it kept failing (for example, its session is gone)
 */
export type NoticeState = "pending" | "sent" | "dropped"

/** A monitor as written to the state file, so its end can be reported after OpenCode restarts. */
export interface StoredMonitor {
  id: string
  description: string
  command: string
  sessionID: string
  directory?: string
  startedAt: string
  endedAt?: string
  status: MonitorStatus
  endReason?: EndReason
  exitCode?: number | null
  signal?: string | null
  pid?: number
  filter?: string
  until?: string
  linesEmitted: number
  notice?: NoticeState
  /** The OpenCode process that owns the monitor. */
  ownerPid: number
}

export interface MonitorStore {
  read(): StoredMonitor[]
  /** Replaces this process's records, keeping records other processes own. */
  save(records: StoredMonitor[]): void
}

export function defaultStateFile(): string {
  if (process.env.SENTINEL_STATE_FILE) return process.env.SENTINEL_STATE_FILE
  const base = process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state")
  return path.join(base, "opencode-sentinel", "monitors.json")
}

/**
 * A JSON file shared by every OpenCode process on the machine. Each process
 * rewrites only its own records; writes go through a temp file and a rename
 * so a reader never sees half a file.
 */
export function createFileStore(file = defaultStateFile(), ownerPid = process.pid): MonitorStore {
  const read = (): StoredMonitor[] => {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"))
      return Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.id === "string") : []
    } catch {
      return []
    }
  }

  return {
    read,
    save(records) {
      const mine = new Set(records.map((r) => r.id))
      const others = read().filter((r) => r.ownerPid !== ownerPid && !mine.has(r.id))
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      writeFileSync(temp, JSON.stringify([...others, ...records], null, 2) + "\n", { mode: 0o600 })
      renameSync(temp, file)
    },
  }
}
