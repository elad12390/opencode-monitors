import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test"
import { EventEmitter } from "node:events"

mock.module("node:child_process", () => ({
  spawn: () => {
    const proc = new EventEmitter() as any
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.pid = 12345
    return proc
  },
}))

mock.module("node:fs", () => {
  const fsMock = {
    appendFileSync: () => {},
    existsSync: () => false,
    mkdirSync: () => {},
  }
  return { default: fsMock, ...fsMock }
})

const core = await import("../src/lib/core")
const { manager } = await import("../src/lib/manager")

const deliver = async () => {}

function startId(result: string): string {
  const match = result.match(/Monitor started: (\S+)/)
  if (!match) throw new Error(`no id in: ${result}`)
  return match[1]
}

describe("core", () => {
  let origKill: typeof process.kill

  beforeEach(() => {
    origKill = process.kill
    // The mock spawn uses a fake pid; stub the process-group kill so tests do
    // not fire a real signal.
    ;(process as any).kill = () => {}
    manager.dispose()
  })

  afterEach(() => {
    manager.dispose()
    process.kill = origKill
  })

  describe("startMonitor", () => {
    test("registers the monitor and returns its id", () => {
      const result = core.startMonitor({
        command: "echo hi",
        description: "greeting",
        sessionID: "ses_1",
        deliver,
      })

      const id = startId(result)
      expect(id).toMatch(/^mon_/)
      expect(result).toContain("echo hi")

      const entry = manager.get(id)
      expect(entry).toBeDefined()
      expect(entry!.description).toBe("greeting")
      expect(entry!.command).toBe("echo hi")
      expect(entry!.linesEmitted).toBe(0)
    })

    test("accepts valid filter and until regexes and stores them", () => {
      const result = core.startMonitor({
        command: "tail -f log",
        description: "filtered",
        filter: "ERROR.*",
        until: "DONE",
        sessionID: "ses_1",
        deliver,
      })

      const entry = manager.get(startId(result))
      expect(entry!.filter).toBe("ERROR.*")
      expect(entry!.until).toBe("DONE")
    })

    test("rejects an invalid filter regex without starting a monitor", () => {
      const before = manager.list().length
      const result = core.startMonitor({
        command: "echo hi",
        description: "bad filter",
        filter: "(",
        sessionID: "ses_1",
        deliver,
      })

      expect(result.startsWith("Invalid filter regex:")).toBe(true)
      expect(manager.list().length).toBe(before)
    })

    test("rejects an invalid until regex without starting a monitor", () => {
      const before = manager.list().length
      const result = core.startMonitor({
        command: "echo hi",
        description: "bad until",
        until: "[",
        sessionID: "ses_1",
        deliver,
      })

      expect(result.startsWith("Invalid until regex:")).toBe(true)
      expect(manager.list().length).toBe(before)
    })
  })

  describe("stopMonitor", () => {
    test("stops a running monitor", () => {
      const id = startId(
        core.startMonitor({
          command: "echo hi",
          description: "to stop",
          sessionID: "ses_1",
          deliver,
        }),
      )

      expect(core.stopMonitor(id)).toBe(`Monitor ${id} stopped.`)
      expect(manager.get(id)).toBeUndefined()
    })

    test("reports an error for an unknown id", () => {
      const result = core.stopMonitor("mon_missing")
      expect(result.startsWith("Error:")).toBe(true)
      expect(result).toContain("mon_missing")
    })
  })

  describe("listMonitors", () => {
    test("reports when nothing is running", () => {
      expect(core.listMonitors()).toBe("No monitors are currently running.")
    })

    test("lists running monitors with their metadata", () => {
      core.startMonitor({
        command: "tail -f app.log",
        description: "app log",
        filter: "ERROR",
        sessionID: "ses_1",
        deliver,
      })

      const listed = core.listMonitors()
      expect(listed).toContain("app log")
      expect(listed).toContain("tail -f app.log")
      expect(listed).toContain("filter: ERROR")
      expect(listed).toContain("lines: 0")
    })
  })
})
