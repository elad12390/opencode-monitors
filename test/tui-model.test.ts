import { describe, expect, test } from "bun:test"
import {
  fit,
  formatDuration,
  logWindow,
  reselect,
  statusLabel,
  summary,
  timing,
  type Monitor,
} from "../src/tui/model"

function monitor(overrides: Partial<Monitor>): Monitor {
  return {
    id: "mon_1",
    description: "watch",
    command: "tail -f log",
    startedAt: "2026-10-26T10:00:00.000Z",
    linesEmitted: 0,
    sessionID: "ses_1",
    status: "running",
    ...overrides,
  }
}

describe("statusLabel", () => {
  test("names how a monitor ended", () => {
    expect(statusLabel(monitor({ status: "running" })).text).toBe("running")
    expect(statusLabel(monitor({ status: "failed", exitCode: 3 })).text).toBe("failed (exit 3)")
    expect(statusLabel(monitor({ status: "failed", signal: "SIGKILL" })).text).toBe("killed (SIGKILL)")
    expect(statusLabel(monitor({ status: "flood" })).text).toBe("stopped: flood")
  })

  test("uses plain ASCII icons in monochrome mode", () => {
    expect(statusLabel(monitor({ status: "completed" }), true).icon).toBe("+")
  })
})

describe("timing", () => {
  const now = Date.parse("2026-10-26T10:03:12.000Z")

  test("shows how long a running monitor has been going", () => {
    expect(timing(monitor({ status: "running" }), now)).toBe("3m 12s")
  })

  test("shows how long ago a finished monitor ended", () => {
    expect(timing(monitor({ status: "completed", endedAt: "2026-10-26T10:03:00.000Z" }), now)).toBe("12s ago")
  })

  test("formats hours", () => {
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 05m")
  })
})

describe("summary", () => {
  test("counts running and finished monitors", () => {
    expect(summary([])).toBe("none yet")
    expect(summary([monitor({}), monitor({ status: "stopped" })])).toBe("1 running · 1 finished")
    expect(summary([monitor({ status: "completed" })])).toBe("1 finished")
  })
})

describe("reselect", () => {
  const list = [monitor({ id: "a" }), monitor({ id: "b" }), monitor({ id: "c" })]

  test("follows the selected monitor when the list order changes", () => {
    expect(reselect(list, "c", 0)).toBe(2)
  })

  test("stays inside the list when the selected monitor disappears", () => {
    expect(reselect(list.slice(0, 1), "c", 2)).toBe(0)
    expect(reselect([], "c", 2)).toBe(0)
  })
})

describe("logWindow", () => {
  const lines = Array.from({ length: 10 }, (_, i) => i)

  test("shows the newest lines by default", () => {
    expect(logWindow(lines, 3, 0).lines).toEqual([7, 8, 9])
  })

  test("scrolls back and clamps at the oldest line", () => {
    expect(logWindow(lines, 3, 2).lines).toEqual([5, 6, 7])
    expect(logWindow(lines, 3, 50)).toEqual({ lines: [0, 1, 2], scrollBack: 7, maxBack: 7 })
  })
})

describe("fit", () => {
  test("cuts long text with an ellipsis", () => {
    expect(fit("abcdefgh", 5)).toBe("abcd…")
    expect(fit("abcdefgh", 5, true)).toBe("ab...")
    expect(fit("abc", 5)).toBe("abc")
  })
})
