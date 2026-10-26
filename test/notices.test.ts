import { describe, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { MonitorManager, type MonitorEntry } from "../src/lib/manager"
import type { MonitorStore, StoredMonitor } from "../src/lib/state"

// The agent hears about every way a monitor can end except the ones it caused
// or watched happen (see src/lib/notices.ts).

function setup() {
  const manager = new MonitorManager()
  let saved: StoredMonitor[] = []
  const store: MonitorStore = { read: () => saved, save: (records) => (saved = records) }
  manager.persistTo(store)
  const told: string[] = []
  const entry = (id: string, owner = "setup-a"): MonitorEntry => ({
    id,
    proc: { pid: undefined } as unknown as ChildProcess,
    description: `monitor ${id}`,
    command: `watch ${id}`,
    startedAt: new Date().toISOString(),
    linesEmitted: 0,
    sessionID: "ses_1",
    owner,
    deliver: async (text) => {
      told.push(text)
    },
  })
  return { manager, told, entry, saved: () => saved }
}

const settle = () => Bun.sleep(10)

describe("end notices", () => {
  test("killing a monitor from /monitors tells the agent the user did it", async () => {
    const { manager, told, entry } = setup()
    manager.start(entry("a"))
    manager.stop("a", "stopped", "user")
    await settle()
    expect(told).toEqual([`[monitor:a] "monitor a" was killed by the user from /monitors. It is no longer running.`])
  })

  test("the agent's own stop_monitor and a deleted session send no notice", async () => {
    const { manager, told, entry } = setup()
    manager.start(entry("a"))
    manager.start(entry("b"))
    manager.stop("a")
    manager.disposeSession("ses_1")
    await settle()
    expect(told).toEqual([])
    expect(manager.all().map((m) => m.endReason)).toEqual(["session", "agent"])
  })

  test("unloading the plugin in one project stops only that project's monitors, and says so", async () => {
    const { manager, told, entry } = setup()
    manager.start(entry("mine", "setup-a"))
    manager.start(entry("theirs", "setup-b"))

    manager.disposeOwner("setup-a")
    await settle()

    const byID = Object.fromEntries(manager.all().map((m) => [m.id, m]))
    expect(byID.mine).toMatchObject({ status: "stopped", endReason: "unload" })
    expect(byID.theirs.status).toBe("running")
    expect(told).toEqual([
      `[monitor:mine] "monitor mine" stopped because the monitors plugin was unloaded or OpenCode shut down. It is no longer running. If you still need it, start it again with monitor (command: "watch mine").`,
    ])
  })

  test("a notice that fails is retried, and the state file records when it got through", async () => {
    const { manager, entry, saved } = setup()
    let attempts = 0
    manager.start({
      ...entry("a"),
      deliver: async () => {
        attempts++
        if (attempts < 2) throw new Error("server busy")
      },
    })
    manager.exited("a", 0, null)
    expect(saved()[0].notice).toBe("pending")

    await Bun.sleep(1_200)
    expect(attempts).toBe(2)
    expect(saved()[0].notice).toBe("sent")
  })

  test("a notice that keeps failing is dropped instead of retried forever", async () => {
    const { manager, entry, saved } = setup()
    manager.start({
      ...entry("a"),
      deliver: async () => {
        throw new Error("session gone")
      },
    })
    manager.exited("a", 1, null)
    await manager.announce("a", undefined, [0, 0, 0])
    expect(saved()[0].notice).toBe("dropped")
  })

  test("the state file always holds the current status of every monitor", () => {
    const { manager, entry, saved } = setup()
    manager.start(entry("a"))
    expect(saved().map((r) => [r.id, r.status, r.ownerPid])).toEqual([["a", "running", process.pid]])
    manager.exited("a", 3, null)
    expect(saved()[0]).toMatchObject({ status: "failed", exitCode: 3, endReason: "exit" })
  })
})
