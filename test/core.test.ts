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
  const match = result.match(/Started monitor (\S+)/)
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

      expect(result).toStartWith('Did not start the monitor: the filter pattern "(" is not a valid JavaScript regex')
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

      expect(result).toStartWith('Did not start the monitor: the until pattern "[" is not a valid JavaScript regex')
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

      expect(core.stopMonitor(id)).toBe(`Stopped monitor ${id} "to stop" and killed its command.`)
      expect(manager.get(id)).toBeUndefined()
    })

    test("finds the monitor by its description, ignoring case", () => {
      const id = startId(core.startMonitor({ command: "sleep 9", description: "API errors", sessionID: "ses_1", deliver }))
      expect(core.stopMonitor("  api ERRORS ")).toBe(`Stopped monitor ${id} "API errors" and killed its command.`)
      expect(manager.get(id)).toBeUndefined()
    })

    test("stops nothing when two monitors share the description, and lists their IDs", () => {
      const a = startId(core.startMonitor({ command: "sleep 1", description: "watch", sessionID: "ses_1", deliver }))
      const b = startId(core.startMonitor({ command: "sleep 2", description: "watch", sessionID: "ses_1", deliver }))
      const result = core.stopMonitor("watch")
      expect(result).toBe(
        `2 running monitors are called "watch"; nothing was stopped. Pass one of their IDs instead:\n- ${a}: sleep 1\n- ${b}: sleep 2`,
      )
      expect(manager.get(a)).toBeDefined()
      expect(manager.get(b)).toBeDefined()
    })

    test("says which monitors are running when the name matches none", () => {
      const id = startId(core.startMonitor({ command: "sleep 1", description: "build", sessionID: "ses_1", deliver }))
      expect(core.stopMonitor("deploy")).toBe(
        `No running monitor has the ID or description "deploy"; nothing was stopped. Running now:\n- ${id} "build"`,
      )
    })

    test("says when nothing is running at all", () => {
      expect(core.stopMonitor("anything")).toBe("No monitor is running, so there was nothing to stop.")
    })
  })

  describe("listMonitors", () => {
    test("reports when nothing is running", () => {
      expect(core.listMonitors()).toBe("No monitors are running.")
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
      expect(listed).toMatch(
        /^1 monitor is running:\n- mon_\S+ "app log" \(running \d+s, 0 lines printed, filter "ERROR"\)\n {2}\$ tail -f app\.log$/,
      )
    })
  })
})
