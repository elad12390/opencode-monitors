/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { MonitorsDialog, type MonitorSource, type Palette } from "../src/tui/MonitorsDialog"
import type { LogLine, Monitor } from "../src/tui/model"

// Renders the real popup with OpenTUI's test renderer and drives it with real
// key presses. Only the data source is in memory instead of the server RPC.

const NOW = Date.parse("2026-10-26T10:05:00.000Z")

const palette: Palette = {
  text: RGBA.fromHex("#e0e0e0"),
  muted: RGBA.fromHex("#a0a0a0"),
  faint: RGBA.fromHex("#707070"),
  border: RGBA.fromHex("#404040"),
  selectedBg: RGBA.fromHex("#303040"),
  running: RGBA.fromHex("#5fafff"),
  success: RGBA.fromHex("#5fd75f"),
  error: RGBA.fromHex("#ff5f5f"),
  warning: RGBA.fromHex("#ffaf00"),
}

function monitor(overrides: Partial<Monitor>): Monitor {
  return {
    id: "mon_api",
    description: "API error log",
    command: "tail -f api.log | grep --line-buffered ERROR",
    startedAt: "2026-10-26T10:00:48.000Z",
    linesEmitted: 1204,
    sessionID: "ses_1",
    status: "running",
    pid: 4242,
    filter: "ERROR",
    ...overrides,
  }
}

function fakeSource(initial: Monitor[], logs: Record<string, LogLine[]> = {}) {
  let monitors = initial
  const stopped: string[] = []
  const source: MonitorSource = {
    list: async () => monitors,
    logs: async (id, limit) => (logs[id] ?? []).slice(-limit),
    stop: async (id) => {
      stopped.push(id)
      monitors = monitors.map((m) =>
        m.id === id ? { ...m, status: "stopped", endedAt: new Date(NOW).toISOString() } : m,
      )
      return true
    },
  }
  return { source, stopped }
}

function logLines(count: number, stream: LogLine["stream"] = "stdout", prefix = "line"): LogLine[] {
  return Array.from({ length: count }, (_, i) => ({
    at: new Date(NOW - (count - i) * 1000).toISOString(),
    stream,
    text: `${prefix} ${i + 1}`,
  }))
}

let setup: Awaited<ReturnType<typeof testRender>> | undefined

afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

async function render(
  source: MonitorSource,
  notices: string[] = [],
  size = { width: 140, height: 40 },
  scopeProps: { currentDirectory?: string; initialScope?: "all" | "project"; onScopeChange?: (s: any) => void } = {},
) {
  setup = await testRender(
    () => (
      <MonitorsDialog
        source={source}
        palette={() => palette}
        pollMs={30}
        now={() => NOW}
        notify={(message) => notices.push(message)}
        {...scopeProps}
      />
    ),
    size,
  )
  return setup
}

async function frameWhen(predicate: (frame: string) => boolean, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let frame = ""
  while (Date.now() < deadline) {
    await setup!.renderOnce()
    frame = setup!.captureCharFrame()
    if (predicate(frame)) return frame
    await Bun.sleep(15)
  }
  throw new Error(`frame never matched:\n${frame}`)
}

describe("/monitors popup", () => {
  test("lists monitors with status, timing and line counts, and shows the selected one's logs", async () => {
    const { source } = fakeSource(
      [
        monitor({}),
        monitor({
          id: "mon_tests",
          description: "unit tests",
          command: "bun test --watch",
          status: "failed",
          exitCode: 1,
          endedAt: "2026-10-26T10:04:30.000Z",
          linesEmitted: 40,
        }),
      ],
      { mon_api: [...logLines(2), { at: new Date(NOW).toISOString(), stream: "stderr", text: "connection reset" }] },
    )
    await render(source)

    const frame = await frameWhen((f) => f.includes("connection reset"))
    expect(frame).toContain("Monitors")
    expect(frame).toContain("1 running · 1 finished")
    expect(frame).toContain("API error log")
    expect(frame).toContain("running")
    expect(frame).toContain("4m 12s")
    expect(frame).toContain("1,204 lines")
    expect(frame).toContain("unit tests")
    expect(frame).toContain("failed (exit 1)")
    expect(frame).toContain("30s ago")
    expect(frame).toContain("$ tail -f api.log | grep --line-buffered ERROR")
    expect(frame).toContain("pid 4242")
    expect(frame).toContain("filter ERROR")
    expect(frame).toContain("line 2")
    expect(frame).toContain("↑↓ select · enter full logs · k kill · esc close")
  })

  test("down arrow selects the next monitor and shows its logs", async () => {
    const { source } = fakeSource(
      [monitor({}), monitor({ id: "mon_ci", description: "CI run", command: "gh run watch 42" })],
      { mon_api: logLines(1, "stdout", "api"), mon_ci: logLines(1, "stdout", "ci step") },
    )
    await render(source)
    await frameWhen((f) => f.includes("api 1"))

    setup!.mockInput.pressArrow("down")
    const frame = await frameWhen((f) => f.includes("ci step 1"))
    expect(frame).toContain("$ gh run watch 42")
    expect(frame).not.toContain("api 1")
  })

  test("k asks for confirmation, and a second k kills the monitor", async () => {
    const notices: string[] = []
    const { source, stopped } = fakeSource([monitor({})])
    await render(source, notices)
    await frameWhen((f) => f.includes("API error log"))

    setup!.mockInput.pressKey("k")
    await frameWhen((f) => f.includes("Press k again to kill “API error log”"))
    expect(stopped).toEqual([])

    setup!.mockInput.pressKey("k")
    const frame = await frameWhen((f) => f.includes("stopped") && !f.includes("Press k again"))
    expect(stopped).toEqual(["mon_api"])
    expect(notices).toContain("Killed “API error log”")
    expect(frame).toContain("1 finished")
  })

  test("k on a finished monitor says so instead of killing", async () => {
    const notices: string[] = []
    const { source, stopped } = fakeSource([monitor({ status: "completed", endedAt: new Date(NOW).toISOString() })])
    await render(source, notices)
    await frameWhen((f) => f.includes("API error log"))

    const frame = await frameWhen((f) => f.includes("esc close"))
    expect(frame).toContain("↑↓ select · enter full logs · esc close")

    setup!.mockInput.pressKey("k")
    await Bun.sleep(50)
    expect(stopped).toEqual([])
    expect(notices).toEqual(["“API error log” already finished"])
  })

  test("enter expands the logs, and up scrolls back through them", async () => {
    const { source } = fakeSource([monitor({})], { mon_api: logLines(120) })
    await render(source)
    await frameWhen((f) => f.includes("line 120"))

    setup!.mockInput.pressEnter()
    let frame = await frameWhen((f) => f.includes("end follow"))
    expect(frame).toContain("line 120")
    expect(frame).not.toContain("1,204 lines   tail")

    setup!.mockInput.pressArrow("up")
    setup!.mockInput.pressArrow("up")
    frame = await frameWhen((f) => f.includes("2 newer lines below"))
    expect(frame).not.toContain("line 120")
    expect(frame).toContain("line 118")

    setup!.mockInput.pressKey("\x1b[F")
    frame = await frameWhen((f) => f.includes("line 120") && !f.includes("newer lines below"))
  })

  test("explains how to start one when there are no monitors", async () => {
    const { source } = fakeSource([])
    await render(source)
    const frame = await frameWhen((f) => f.includes("No monitors yet"))
    expect(frame).toContain("none yet")
    expect(frame).toContain("esc close")
  })

  test("tab switches between all projects and this project, and remembers the choice", async () => {
    const scopes: string[] = []
    const { source } = fakeSource([
      monitor({ id: "mon_api", description: "API error log", directory: "/work/api" }),
      monitor({ id: "mon_web", description: "web dev server", directory: "/work/web" }),
    ])
    await render(source, [], undefined, {
      currentDirectory: "/work/api",
      initialScope: "all",
      onScopeChange: (scope) => scopes.push(scope),
    })

    let frame = await frameWhen((f) => f.includes("web dev server"))
    expect(frame).toContain("All projects")
    expect(frame).toContain("This project (api)")
    expect(frame).toContain("2 running")
    expect(frame).toMatch(/API error log\s+api\s+running/)
    expect(frame).toMatch(/web dev server\s+web\s+running/)
    expect(frame).toContain("tab this project")

    setup!.mockInput.pressTab()
    frame = await frameWhen((f) => !f.includes("web dev server"))
    expect(frame).toContain("API error log")
    expect(frame).toContain("1 running")
    expect(frame).toContain("tab all projects")
    expect(scopes).toEqual(["project"])

    setup!.mockInput.pressTab()
    await frameWhen((f) => f.includes("web dev server"))
    expect(scopes).toEqual(["project", "all"])
  })

  test("starts in this project when that was the last choice, and says when it has none", async () => {
    const { source } = fakeSource([monitor({ id: "mon_web", description: "web dev server", directory: "/work/web" })])
    await render(source, [], undefined, { currentDirectory: "/work/api", initialScope: "project" })

    const frame = await frameWhen((f) => f.includes("No monitors in this project"))
    expect(frame).toContain("1 monitor in other projects; press tab to see all projects")
    expect(frame).not.toContain("web dev server")
  })

  test("a monitor stopped by an OpenCode restart says so, and that its output was not kept", async () => {
    const { source } = fakeSource([
      monitor({ status: "stopped", endReason: "restart", restored: true, endedAt: new Date(NOW).toISOString() }),
    ])
    await render(source)
    const frame = await frameWhen((f) => f.includes("OpenCode restarted"))
    expect(frame).toContain("Output isn't kept across OpenCode restarts.")
  })

  test("says when the server plugin can't be reached", async () => {
    const source: MonitorSource = {
      list: async () => {
        throw new Error("rpc.unavailable")
      },
      logs: async () => [],
      stop: async () => false,
    }
    await render(source)
    const frame = await frameWhen((f) => f.includes("Can't reach the opencode-monitors server plugin"))
    expect(frame).toContain("rpc.unavailable")
  })
})
