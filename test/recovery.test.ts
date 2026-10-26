import { describe, expect, test } from "bun:test"
import { MonitorManager } from "../src/lib/manager"
import { announcePending, recoverMonitors } from "../src/lib/recovery"
import type { MonitorStore, StoredMonitor } from "../src/lib/state"

const DEAD_OPENCODE = 999_001
const LIVE_OPENCODE = 999_002

function stored(overrides: Partial<StoredMonitor>): StoredMonitor {
  return {
    id: "mon_a",
    description: "API log",
    command: "tail -f api.log",
    sessionID: "ses_1",
    directory: "/work/api",
    startedAt: "2026-10-26T10:00:00.000Z",
    status: "running",
    linesEmitted: 3,
    pid: 4242,
    ownerPid: DEAD_OPENCODE,
    ...overrides,
  }
}

function memoryStore(records: StoredMonitor[]) {
  let saved: StoredMonitor[] = records
  const store: MonitorStore = {
    read: () => saved,
    save: (mine) => {
      const ids = new Set(mine.map((r) => r.id))
      const token = mine[0]?.ownerToken
      saved = [...saved.filter((r) => (token === undefined || r.ownerToken !== token) && !ids.has(r.id)), ...mine]
    },
  }
  return { store, saved: () => saved }
}

function recover(records: StoredMonitor[]) {
  const manager = new MonitorManager()
  const { store, saved } = memoryStore(records)
  const killed: string[] = []
  const ended = recoverMonitors({
    manager,
    store,
    isOwnerAlive: (pid) => pid === LIVE_OPENCODE,
    killOrphan: (record) => {
      killed.push(record.id)
      return true
    },
    now: () => new Date("2026-10-26T11:00:00.000Z"),
  })
  return { manager, saved, killed, ended }
}

describe("recovering monitors after OpenCode restarts", () => {
  test("a monitor that was running when its OpenCode died is stopped by the restart and its process is killed", () => {
    const { manager, killed, ended } = recover([stored({})])

    expect(ended).toEqual(["mon_a"])
    expect(killed).toEqual(["mon_a"])
    expect(manager.all()[0]).toMatchObject({
      id: "mon_a",
      status: "stopped",
      endReason: "restart",
      endedAt: "2026-10-26T11:00:00.000Z",
      restored: true,
    })
    expect(manager.pendingNotices().map((m) => m.id)).toEqual(["mon_a"])
  })

  test("the session is told it stopped and how to start it again", async () => {
    const { manager, saved } = recover([stored({})])
    const told: { sessionID: string; text: string }[] = []

    announcePending({
      manager,
      directory: "/work/api",
      deliverTo: (sessionID) => async (text) => {
        told.push({ sessionID, text })
      },
      delayMs: 0,
    })
    await Bun.sleep(20)

    expect(told).toEqual([
      {
        sessionID: "ses_1",
        text: `[monitor:mon_a] "API log" stopped because OpenCode restarted (noticed at 2026-10-26T11:00:00.000Z). It is no longer running. If you still need it, start it again with monitor (command: "tail -f api.log").`,
      },
    ])
    expect(saved().find((r) => r.id === "mon_a")).toMatchObject({ notice: "sent", ownerPid: process.pid })
  })

  test("a notice waits until the monitor's own project is open", async () => {
    const { manager } = recover([stored({})])
    const told: string[] = []
    const deliverTo = () => async (text: string) => {
      told.push(text)
    }

    announcePending({ manager, directory: "/work/other", deliverTo, delayMs: 0 })
    await Bun.sleep(20)
    expect(told).toEqual([])

    announcePending({ manager, directory: "/work/api", deliverTo, delayMs: 0 })
    await Bun.sleep(20)
    expect(told).toHaveLength(1)
  })

  test("monitors owned by another OpenCode that is still running are left alone", () => {
    const { manager, killed, ended, saved } = recover([stored({ ownerPid: LIVE_OPENCODE })])

    expect(ended).toEqual([])
    expect(killed).toEqual([])
    expect(manager.all()).toEqual([])
    expect(saved()[0]).toMatchObject({ status: "running", ownerPid: LIVE_OPENCODE })
  })

  test("monitors owned by this same OpenCode process are never touched, even by a manager that does not know them", () => {
    // OpenCode loads one plugin copy per open project; another copy may own it.
    const { manager, killed, ended } = recover([stored({ ownerPid: process.pid, ownerToken: "another-copy" })])
    expect(ended).toEqual([])
    expect(killed).toEqual([])
    expect(manager.all()).toEqual([])
  })

  test("finished monitors come back as history, and an undelivered end is still announced", () => {
    const { manager, killed } = recover([
      stored({ id: "mon_done", status: "completed", endReason: "exit", exitCode: 0, notice: "sent" }),
      stored({ id: "mon_failed", status: "failed", endReason: "exit", exitCode: 2, notice: "pending" }),
    ])

    expect(killed).toEqual([])
    expect(manager.all().map((m) => [m.id, m.status, m.restored])).toEqual([
      ["mon_failed", "failed", true],
      ["mon_done", "completed", true],
    ])
    expect(manager.pendingNotices().map((m) => m.id)).toEqual(["mon_failed"])
  })

  test("recovering twice in one process does not repeat anything", () => {
    const manager = new MonitorManager()
    const { store } = memoryStore([stored({})])
    const options = {
      manager,
      store,
      isOwnerAlive: () => false,
      killOrphan: () => true,
    }
    expect(recoverMonitors(options)).toEqual(["mon_a"])
    expect(recoverMonitors(options)).toEqual([])
    expect(manager.all()).toHaveLength(1)
  })
})
