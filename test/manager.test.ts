import { describe, expect, test, beforeEach } from "bun:test"
import { MonitorManager, type MonitorEntry } from "../src/lib/manager"
import type { ChildProcess } from "node:child_process"

function mockProc(pid = 12345): ChildProcess {
  return { pid, kill: () => true, on: () => {}, stdout: null, stderr: null } as unknown as ChildProcess
}

function mockEntry(overrides: Partial<MonitorEntry> = {}): MonitorEntry {
  return {
    id: "mon_test",
    proc: mockProc(),
    description: "test monitor",
    command: "echo hello",
    startedAt: new Date().toISOString(),
    linesEmitted: 0,
    sessionID: "ses_test",
    ...overrides,
  }
}

describe("MonitorManager", () => {
  let mgr: MonitorManager

  beforeEach(() => {
    mgr = new MonitorManager()
  })

  describe("start", () => {
    test("stores entry and returns id", () => {
      const entry = mockEntry()
      const id = mgr.start(entry)
      expect(id).toBe("mon_test")
    })

    test("entry is retrievable after start", () => {
      const entry = mockEntry()
      mgr.start(entry)
      expect(mgr.get("mon_test")).toBe(entry)
    })
  })

  describe("stop", () => {
    test("removes entry after stop", () => {
      mgr.start(mockEntry())
      mgr.stop("mon_test")
      expect(mgr.get("mon_test")).toBeUndefined()
    })

    test("throws for non-existent id", () => {
      expect(() => mgr.stop("nonexistent")).toThrow("Monitor not found")
    })

    test("stop removes from list", () => {
      mgr.start(mockEntry({ id: "mon_1" }))
      mgr.start(mockEntry({ id: "mon_2" }))
      mgr.stop("mon_1")
      const list = mgr.list()
      expect(list.length).toBe(1)
      expect(list[0].id).toBe("mon_2")
    })
  })

  describe("get", () => {
    test("returns undefined for unknown id", () => {
      expect(mgr.get("nonexistent")).toBeUndefined()
    })

    test("returns entry for known id", () => {
      const entry = mockEntry({ id: "mon_x" })
      mgr.start(entry)
      expect(mgr.get("mon_x")).toBe(entry)
    })
  })

  describe("list", () => {
    test("returns empty array initially", () => {
      expect(mgr.list()).toEqual([])
    })

    test("returns public entries (no proc field)", () => {
      mgr.start(mockEntry({ id: "mon_a", description: "A" }))
      const items = mgr.list()
      expect(items.length).toBe(1)
      expect(items[0].id).toBe("mon_a")
      expect(items[0].description).toBe("A")
      // proc should NOT be in public output
      expect((items[0] as any).proc).toBeUndefined()
    })

    test("returns multiple entries", () => {
      mgr.start(mockEntry({ id: "mon_a" }))
      mgr.start(mockEntry({ id: "mon_b" }))
      expect(mgr.list().length).toBe(2)
    })

    test("includes filter and until when set", () => {
      mgr.start(mockEntry({ id: "mon_f", filter: "ERROR", until: "DONE" }))
      const items = mgr.list()
      expect(items[0].filter).toBe("ERROR")
      expect(items[0].until).toBe("DONE")
    })

    test("filter and until are undefined when not set", () => {
      mgr.start(mockEntry({ id: "mon_nf" }))
      const items = mgr.list()
      expect(items[0].filter).toBeUndefined()
      expect(items[0].until).toBeUndefined()
    })
  })

  describe("incrementLines", () => {
    test("increments counter", () => {
      mgr.start(mockEntry({ id: "mon_c", linesEmitted: 0 }))
      mgr.incrementLines("mon_c")
      mgr.incrementLines("mon_c")
      const items = mgr.list()
      expect(items[0].linesEmitted).toBe(2)
    })

    test("does nothing for unknown id", () => {
      expect(() => mgr.incrementLines("nonexistent")).not.toThrow()
    })
  })

  describe("dispose", () => {
    test("clears all entries", () => {
      mgr.start(mockEntry({ id: "mon_1" }))
      mgr.start(mockEntry({ id: "mon_2" }))
      mgr.dispose()
      expect(mgr.list().length).toBe(0)
    })

    test("multiple disposes are safe", () => {
      mgr.start(mockEntry())
      mgr.dispose()
      expect(() => mgr.dispose()).not.toThrow()
    })
  })

  describe("disposeSession", () => {
    test("stops only monitors owned by the given session", () => {
      mgr.start(mockEntry({ id: "mon_a", sessionID: "ses_a" }))
      mgr.start(mockEntry({ id: "mon_b", sessionID: "ses_b" }))

      mgr.disposeSession("ses_a")

      expect(mgr.get("mon_a")).toBeUndefined()
      expect(mgr.get("mon_b")).toBeDefined()
    })

    test("is a no-op for an unknown session", () => {
      mgr.start(mockEntry({ id: "mon_a", sessionID: "ses_a" }))
      expect(() => mgr.disposeSession("ses_missing")).not.toThrow()
      expect(mgr.get("mon_a")).toBeDefined()
    })
  })
})
