import { describe, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { LogBuffer } from "../src/lib/logs"
import { MAX_FINISHED, MonitorManager, type MonitorEntry } from "../src/lib/manager"

function entry(id: string, sessionID = "ses_a"): MonitorEntry {
  return {
    id,
    proc: { pid: undefined } as unknown as ChildProcess,
    description: `monitor ${id}`,
    command: "echo hi",
    startedAt: new Date().toISOString(),
    linesEmitted: 0,
    sessionID,
  }
}

describe("monitor lifecycle", () => {
  test("a command that exits by itself is completed or failed, with its exit code", () => {
    const mgr = new MonitorManager()
    mgr.start(entry("ok"))
    mgr.start(entry("bad"))

    mgr.exited("ok", 0, null)
    mgr.exited("bad", 2, null)

    const byID = Object.fromEntries(mgr.all().map((m) => [m.id, m]))
    expect(byID.ok.status).toBe("completed")
    expect(byID.bad.status).toBe("failed")
    expect(byID.bad.exitCode).toBe(2)
    expect(byID.ok.endedAt).toBeString()
    expect(mgr.list()).toEqual([])
  })

  test("a stopped monitor keeps its stop reason when its process exits afterwards", () => {
    const mgr = new MonitorManager()
    mgr.start(entry("a"))
    mgr.start(entry("b"))

    mgr.stop("a")
    mgr.stop("b", "flood")
    mgr.exited("a", null, "SIGTERM")
    mgr.exited("b", null, "SIGTERM")

    const byID = Object.fromEntries(mgr.all().map((m) => [m.id, m]))
    expect(byID.a.status).toBe("stopped")
    expect(byID.a.signal).toBe("SIGTERM")
    expect(byID.b.status).toBe("flood")
  })

  test("all() lists running monitors first, then finished ones, newest first", () => {
    const mgr = new MonitorManager()
    for (const id of ["one", "two", "three", "four"]) mgr.start(entry(id))
    mgr.exited("one", 0, null)
    mgr.exited("three", 0, null)

    expect(mgr.all().map((m) => [m.id, m.status])).toEqual([
      ["four", "running"],
      ["two", "running"],
      ["three", "completed"],
      ["one", "completed"],
    ])
  })

  test("only the most recent finished monitors are kept", () => {
    const mgr = new MonitorManager()
    for (let i = 0; i < MAX_FINISHED + 5; i++) {
      mgr.start(entry(`m${i}`))
      mgr.exited(`m${i}`, 0, null)
    }
    const ids = mgr.all().map((m) => m.id)
    expect(ids).toHaveLength(MAX_FINISHED)
    expect(ids).not.toContain("m0")
    expect(ids[0]).toBe(`m${MAX_FINISHED + 4}`)
  })

  test("logs stay readable after a monitor finishes", () => {
    const mgr = new MonitorManager()
    mgr.start(entry("a"))
    mgr.appendLog("a", "stdout", "hello")
    mgr.appendLog("a", "stderr", "oops")
    mgr.exited("a", 1, null)

    expect(mgr.logs("a")?.map((l) => [l.stream, l.text])).toEqual([
      ["stdout", "hello"],
      ["stderr", "oops"],
    ])
    expect(mgr.logs("missing")).toBeUndefined()
  })

  test("listeners hear about starts, log lines and endings", () => {
    const mgr = new MonitorManager()
    const heard: string[] = []
    const unsubscribe = mgr.onChange((id) => heard.push(id))
    mgr.start(entry("a"))
    mgr.appendLog("a", "stdout", "x")
    mgr.stop("a")
    unsubscribe()
    mgr.start(entry("b"))

    expect(heard).toEqual(["a", "a", "a"])
  })

  test("ending a session stops its monitors with status stopped", () => {
    const mgr = new MonitorManager()
    mgr.start(entry("mine", "ses_a"))
    mgr.start(entry("theirs", "ses_b"))
    mgr.disposeSession("ses_a")

    const byID = Object.fromEntries(mgr.all().map((m) => [m.id, m]))
    expect(byID.mine.status).toBe("stopped")
    expect(byID.theirs.status).toBe("running")
  })
})

describe("LogBuffer", () => {
  test("drops the oldest lines past the line limit", () => {
    const logs = new LogBuffer(3, 1_000)
    for (const text of ["1", "2", "3", "4", "5"]) logs.append("stdout", text)
    expect(logs.tail().map((l) => l.text)).toEqual(["3", "4", "5"])
  })

  test("drops the oldest lines past the character limit but always keeps the newest", () => {
    const logs = new LogBuffer(100, 10)
    logs.append("stdout", "aaaa")
    logs.append("stdout", "bbbb")
    logs.append("stdout", "cccc")
    expect(logs.tail().map((l) => l.text)).toEqual(["bbbb", "cccc"])
    logs.append("stdout", "x".repeat(50))
    expect(logs.tail().map((l) => l.text)).toEqual(["x".repeat(50)])
  })

  test("tail(n) returns the newest n lines, oldest first", () => {
    const logs = new LogBuffer()
    for (const text of ["a", "b", "c"]) logs.append("stdout", text)
    expect(logs.tail(2).map((l) => l.text)).toEqual(["b", "c"])
  })
})
