import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test"
import { EventEmitter } from "node:events"
import { MonitorManager } from "../src/lib/manager"

const appendFileSyncCalls: Array<{ path: string; data: string }> = []

function createMockProc() {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const proc = new EventEmitter()
  ;(proc as any).stdout = stdout
  ;(proc as any).stderr = stderr
  ;(proc as any).pid = 12345
  return { proc, stdout, stderr }
}

let currentMock = createMockProc()
const spawnCalls: Array<{ command: string; options: any }> = []

mock.module("node:child_process", () => ({
  spawn: (command: string, options: any) => {
    spawnCalls.push({ command, options })
    return currentMock.proc
  },
}))

mock.module("node:fs", () => {
  const fsMock = {
    appendFileSync: (path: string, data: string) => {
      appendFileSyncCalls.push({ path, data })
    },
    existsSync: () => false,
    mkdirSync: () => {},
  }
  return { default: fsMock, ...fsMock }
})

// Dynamic import ensures mocks are applied before the module is evaluated.
// ES module hoisting would otherwise cause the real module to load first.
const watcherModule = await import("../src/lib/watcher")
const startWatcher = watcherModule.startWatcher

describe("startWatcher", () => {
  let manager: MonitorManager
  let deliverCalls: string[]
  let deliver: (text: string) => Promise<void>
  let mockProc: EventEmitter
  let mockStdout: EventEmitter
  let mockStderr: EventEmitter

  beforeEach(() => {
    manager = new MonitorManager()
    deliverCalls = []
    appendFileSyncCalls.length = 0
    spawnCalls.length = 0
    deliver = async (text: string) => {
      deliverCalls.push(text)
    }
    const fresh = createMockProc()
    currentMock = fresh
    mockProc = fresh.proc
    mockStdout = fresh.stdout
    mockStderr = fresh.stderr
  })

  afterEach(() => {
    mockProc.emit("exit", 0)
  })

  test("spawns process and returns ChildProcess", () => {
    const proc = startWatcher({
      id: "mon_test",
      command: "echo hello",
      sessionID: "ses_123",
      deliver,
      manager,
    })
    expect(proc).toBe(mockProc)
  })

  test("passes SENTINEL_SESSION_ID to child process env", () => {
    startWatcher({
      id: "mon_env",
      command: 'echo "$SENTINEL_SESSION_ID"',
      sessionID: "ses_env_test",
      deliver,
      manager,
    })

    expect(spawnCalls.length).toBe(1)
    expect(spawnCalls[0].options.env.SENTINEL_SESSION_ID).toBe(
      "ses_env_test",
    )
  })

  test("batches multiple lines within 200ms into single deliver call", async () => {
    manager.start({
      id: "mon_batch",
      proc: mockProc as any,
      description: "batch test",
      command: "test",
      startedAt: new Date().toISOString(),
      linesEmitted: 0,
      sessionID: "ses_123",
    })

    startWatcher({
      id: "mon_batch",
      command: "test",
      sessionID: "ses_123",
      deliver,
      manager,
    })

    mockStdout.emit("data", Buffer.from("line1\nline2\nline3\n"))
    await new Promise((r) => setTimeout(r, 250))

    expect(deliverCalls.length).toBe(1)
    const text = deliverCalls[0]
    expect(text).toContain("line1")
    expect(text).toContain("line2")
    expect(text).toContain("line3")
  })

  test("sends separate batches when lines arrive >200ms apart", async () => {
    manager.start({
      id: "mon_sep",
      proc: mockProc as any,
      description: "sep test",
      command: "test",
      startedAt: new Date().toISOString(),
      linesEmitted: 0,
      sessionID: "ses_123",
    })

    startWatcher({
      id: "mon_sep",
      command: "test",
      sessionID: "ses_123",
      deliver,
      manager,
    })

    mockStdout.emit("data", Buffer.from("line1\n"))
    await new Promise((r) => setTimeout(r, 250))

    mockStdout.emit("data", Buffer.from("line2\n"))
    await new Promise((r) => setTimeout(r, 250))

    expect(deliverCalls.length).toBe(2)
  })

  test("writes stderr to /tmp/sentinel-{id}-stderr.log", () => {
    startWatcher({
      id: "mon_stderr",
      command: "test",
      sessionID: "ses_123",
      deliver,
      manager,
    })

    mockStderr.emit("data", Buffer.from("error output\n"))

    expect(appendFileSyncCalls.length).toBe(1)
    expect(appendFileSyncCalls[0].path).toBe(
      "/tmp/sentinel-mon_stderr-stderr.log",
    )
    expect(appendFileSyncCalls[0].data).toContain("error output")
  })

  function register(id: string) {
    manager.start({
      id,
      proc: mockProc as any,
      description: `monitor ${id}`,
      command: "test",
      startedAt: new Date().toISOString(),
      linesEmitted: 0,
      sessionID: "ses_123",
      deliver,
    })
  }

  test("tells the agent when the command fails, with its exit code and how to restart it", async () => {
    register("mon_exit")
    startWatcher({ id: "mon_exit", command: "test", sessionID: "ses_123", deliver, manager })

    mockProc.emit("exit", 1)
    await new Promise((r) => setTimeout(r, 50))

    expect(deliverCalls).toContain(
      `[monitor:mon_exit] "monitor mon_exit" ended: the command exited with code 1. It is no longer running. If you still need it, start it again with sentinel_monitor (command: "test").`,
    )
  })

  test("tells the agent when the command finishes cleanly", async () => {
    register("mon_normal")
    startWatcher({ id: "mon_normal", command: "test", sessionID: "ses_123", deliver, manager })

    mockProc.emit("exit", 0)
    await new Promise((r) => setTimeout(r, 50))

    expect(deliverCalls).toEqual([
      `[monitor:mon_normal] "monitor mon_normal" finished: the command exited with code 0. It is no longer running.`,
    ])
  })

  test("the last output arrives before the notice that the command ended", async () => {
    register("mon_order")
    startWatcher({ id: "mon_order", command: "test", sessionID: "ses_123", deliver, manager })

    mockStdout.emit("data", Buffer.from("last words\n"))
    mockProc.emit("exit", 0)
    await new Promise((r) => setTimeout(r, 50))

    expect(deliverCalls).toHaveLength(2)
    expect(deliverCalls[0]).toBe("[monitor:mon_order] last words")
    expect(deliverCalls[1]).toContain("finished")
  })

  test("flood limit: kills process when >100 lines in 1 second", () => {
    const killCalls: Array<[number, string]> = []
    const origKill = process.kill
    try {
      ;(process as any).kill = (pid: number, signal: string) => {
        killCalls.push([pid, signal])
      }

      manager.start({
        id: "mon_flood",
        proc: mockProc as any,
        description: "flood test",
        command: "test",
        startedAt: new Date().toISOString(),
        linesEmitted: 0,
      })

      startWatcher({
        id: "mon_flood",
        command: "test",
        sessionID: "ses_123",
        deliver,
        manager,
      })

      const lines = Array.from({ length: 101 }, (_, i) => `line${i}`).join("\n")
      mockStdout.emit("data", Buffer.from(lines + "\n"))

      expect(killCalls.length).toBeGreaterThan(0)
      const floodCall = deliverCalls.find((t) =>
        t.includes("FLOOD DETECTED"),
      )
      expect(floodCall).toBeDefined()
    } finally {
      process.kill = origKill
    }
  })

  test("flood limit: output still in the pipe after the stop is ignored", () => {
    const origKill = process.kill
    try {
      ;(process as any).kill = () => {}

      manager.start({
        id: "mon_flood_late",
        proc: mockProc as any,
        description: "late output",
        command: "test",
        startedAt: new Date().toISOString(),
        linesEmitted: 0,
        sessionID: "ses_123",
      })

      startWatcher({
        id: "mon_flood_late",
        command: "test",
        sessionID: "ses_123",
        deliver,
        manager,
      })

      const lines = Array.from({ length: 101 }, (_, i) => `line${i}`).join("\n")
      mockStdout.emit("data", Buffer.from(lines + "\n"))
      expect(manager.get("mon_flood_late")).toBeUndefined()

      expect(() =>
        mockStdout.emit("data", Buffer.from(lines + "\n")),
      ).not.toThrow()
      const floods = deliverCalls.filter((t) => t.includes("FLOOD DETECTED"))
      expect(floods).toHaveLength(1)
    } finally {
      process.kill = origKill
    }
  })

  test("filter: only matching lines are notified", async () => {
    manager.start({
      id: "mon_filter",
      proc: mockProc as any,
      description: "filter test",
      command: "test",
      startedAt: new Date().toISOString(),
      linesEmitted: 0,
      sessionID: "ses_123",
    })

    startWatcher({
      id: "mon_filter",
      command: "test",
      sessionID: "ses_123",
      deliver,
      manager,
      filter: "ERROR",
    })

    mockStdout.emit("data", Buffer.from("INFO ok\nERROR bad\nWARN meh\nERROR more\n"))
    await new Promise((r) => setTimeout(r, 250))

    const notifiedText = deliverCalls.join("\n")
    expect(notifiedText).toContain("ERROR bad")
    expect(notifiedText).toContain("ERROR more")
    expect(notifiedText).not.toContain("INFO ok")
    expect(notifiedText).not.toContain("WARN meh")
  })

  test("until: matching line notifies and auto-stops monitor", async () => {
    const killCalls: Array<[number, string]> = []
    const origKill = process.kill
    try {
      ;(process as any).kill = (pid: number, signal: string) => {
        killCalls.push([pid, signal])
      }

      manager.start({
        id: "mon_until",
        proc: mockProc as any,
        description: "until test",
        command: "test",
        startedAt: new Date().toISOString(),
        linesEmitted: 0,
      })

      startWatcher({
        id: "mon_until",
        command: "test",
        sessionID: "ses_123",
        deliver,
        manager,
        until: "DONE",
      })

      mockStdout.emit("data", Buffer.from("working\nworking\nDONE\npost\n"))
      await new Promise((r) => setTimeout(r, 50))

      expect(killCalls.some(([, s]) => s === "SIGTERM")).toBe(true)
      expect(manager.get("mon_until")).toBeUndefined()

      const untilCall = deliverCalls.find((t) =>
        t.includes("UNTIL MATCHED"),
      )
      expect(untilCall).toBeDefined()
      expect(untilCall!).toContain("DONE")

      const notifiedText = deliverCalls.join("\n")
      expect(notifiedText).toContain("DONE")
      expect(notifiedText).not.toContain("post")
    } finally {
      process.kill = origKill
    }
  })

  test("filter + until: until fires only on filter-surviving lines", async () => {
    const killCalls: Array<[number, string]> = []
    const origKill = process.kill
    try {
      ;(process as any).kill = (pid: number, signal: string) => {
        killCalls.push([pid, signal])
      }

      manager.start({
        id: "mon_both",
        proc: mockProc as any,
        description: "filter+until test",
        command: "test",
        startedAt: new Date().toISOString(),
        linesEmitted: 0,
      })

      startWatcher({
        id: "mon_both",
        command: "test",
        sessionID: "ses_123",
        deliver,
        manager,
        filter: "ERROR",
        until: "DONE",
      })

      mockStdout.emit("data", Buffer.from("INFO ignore\nDONE ignored\nERROR DONE\npost\n"))
      await new Promise((r) => setTimeout(r, 50))

      expect(killCalls.some(([, s]) => s === "SIGTERM")).toBe(true)

      const notifiedText = deliverCalls.join("\n")
      expect(notifiedText).toContain("ERROR DONE")
      expect(notifiedText).not.toContain("DONE ignored")
      expect(notifiedText).not.toContain("INFO ignore")
      expect(notifiedText).not.toContain("post")
    } finally {
      process.kill = origKill
    }
  })

  test("deliver rejection is logged and does not stop the watcher", async () => {
    const errors: unknown[][] = []
    const origError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }
    try {
      const failing = async () => {
        throw new Error("deliver boom")
      }
      startWatcher({
        id: "mon_reject",
        command: "test",
        sessionID: "ses_123",
        deliver: failing,
        manager,
      })

      mockStdout.emit("data", Buffer.from("line1\n"))
      await new Promise((r) => setTimeout(r, 250))
      expect(errors.length).toBe(1)
      expect(String(errors[0][1])).toContain("deliver boom")

      // A later line still reaches the watcher despite the earlier rejection.
      mockStdout.emit("data", Buffer.from("line2\n"))
      await new Promise((r) => setTimeout(r, 250))
      expect(errors.length).toBe(2)
    } finally {
      console.error = origError
    }
  })
})
