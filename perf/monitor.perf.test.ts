import { afterEach, describe, expect, test } from "bun:test"
import { manager } from "../src/lib/manager"
import {
  emitCommand,
  isAlive,
  now,
  report,
  round,
  summarize,
  trackCpu,
  trackEventLoopLag,
  waitFor,
  watch,
} from "./helpers"

// Real processes, real pipes, real timers. Only the final hop into an
// OpenCode session is replaced by a recorder, so these numbers are the
// plugin's own cost inside the OpenCode server process.

const BATCH_WINDOW_MS = 200

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  manager.dispose()
})

describe("delivery latency", () => {
  test("sparse lines reach the agent within one batch window", async () => {
    const monitor = watch(emitCommand({ count: 20, rate: 10 }))
    await waitFor(() => monitor.lines().length === 20, 5_000)

    const lines = monitor.lines()
    const latency = summarize(lines.map((l) => l.latencyMs))
    report("latency.sparse-10-per-sec", { latencyMs: latency, deliveries: monitor.deliveries.length })

    expect(lines.map((l) => l.seq)).toEqual([...Array(20).keys()])
    expect(latency.p95).toBeLessThan(BATCH_WINDOW_MS + 100)
    expect(latency.max).toBeLessThan(BATCH_WINDOW_MS + 300)
  })

  test("a steady 50 lines/s stream is grouped into about five messages a second", async () => {
    const monitor = watch(emitCommand({ count: 100, rate: 50 }))
    await waitFor(() => monitor.lines().length === 100, 6_000)

    const lines = monitor.lines()
    const latency = summarize(lines.map((l) => l.latencyMs))
    report("latency.steady-50-per-sec", {
      latencyMs: latency,
      deliveries: monitor.deliveries.length,
      linesPerDelivery: round(lines.length / monitor.deliveries.length),
    })

    expect(lines.map((l) => l.seq)).toEqual([...Array(100).keys()])
    // 2 seconds of output at one message per 200 ms window.
    expect(monitor.deliveries.length).toBeGreaterThanOrEqual(8)
    expect(monitor.deliveries.length).toBeLessThanOrEqual(14)
    expect(latency.p95).toBeLessThan(BATCH_WINDOW_MS + 100)
  })

  test("a burst of 90 lines arrives as one or two messages", async () => {
    const monitor = watch(emitCommand({ count: 90, rate: 0 }))
    await waitFor(() => monitor.lines().length === 90, 5_000)

    const latency = summarize(monitor.lines().map((l) => l.latencyMs))
    report("latency.burst-90", { latencyMs: latency, deliveries: monitor.deliveries.length })

    expect(monitor.lines()).toHaveLength(90)
    expect(monitor.deliveries.length).toBeLessThanOrEqual(2)
    expect(latency.max).toBeLessThan(BATCH_WINDOW_MS + 300)
  })
})

describe("flood protection", () => {
  test("output above 100 lines/s stops the monitor and kills its process within 1.5 s", async () => {
    const startedAt = now()
    const monitor = watch(emitCommand({ count: 5_000, rate: 0, hold: 10_000 }))

    const stopped = await waitFor(() => manager.get(monitor.id) === undefined, 3_000)
    const gone = await waitFor(() => !groupAlive(monitor.pid), 1_500)
    const elapsed = now() - startedAt
    const flood = monitor.deliveries.find((d) => d.text.includes("FLOOD DETECTED"))

    report("flood.stop", {
      stoppedWithinMs: round(elapsed),
      linesDeliveredBeforeStop: monitor.lines().length,
      processGone: gone,
    })

    expect(stopped).toBe(true)
    expect(gone).toBe(true)
    expect(flood).toBeDefined()
    expect(elapsed).toBeLessThan(1_500)
  })
})

describe("scale", () => {
  test("50 monitors at 5 lines/s each lose nothing and keep the event loop responsive", async () => {
    // Each line generator is its own Bun process, and starting 50 of them at
    // once saturates a small CI runner's CPU. That one-time cost belongs to the
    // test harness (lifecycle.100-monitors measures the plugin's start cost),
    // so measuring starts once every monitor is streaming.
    const LINES = 25
    const monitors = Array.from({ length: 50 }, () => watch(emitCommand({ count: LINES, rate: 5 })))
    await waitFor(() => monitors.every((m) => m.lines().length >= 1), 10_000)
    const lag = trackEventLoopLag()
    const cpu = trackCpu()

    const all = await waitFor(() => monitors.every((m) => m.lines().length === LINES), 15_000)
    const usage = cpu.stop()
    const lags = lag.stop()
    const latency = summarize(monitors.flatMap((m) => m.lines().map((l) => l.latencyMs)))
    const loop = summarize(lags)

    report("scale.50-monitors", {
      allLinesDelivered: all,
      latencyMs: latency,
      eventLoopLagMs: loop,
      cpu: usage,
      deliveries: monitors.reduce((sum, m) => sum + m.deliveries.length, 0),
    })

    expect(all).toBe(true)
    expect(latency.p95).toBeLessThan(BATCH_WINDOW_MS + 200)
    expect(loop.p99).toBeLessThan(50)
  })

  test("idle monitors cost almost no CPU", async () => {
    const monitors = Array.from({ length: 20 }, () => watch("sleep 30"))
    await Bun.sleep(300)
    const cpu = trackCpu()
    await Bun.sleep(2_000)
    const usage = cpu.stop()

    report("scale.20-idle-monitors", { cpu: usage, monitors: monitors.length })

    expect(usage.corePercent).toBeLessThan(5)
  })

  test("starting and stopping 100 monitors is fast and leaves no processes behind", async () => {
    const startAt = now()
    const monitors = Array.from({ length: 100 }, () => watch("sleep 30"))
    const startMs = now() - startAt

    const stopAt = now()
    for (const monitor of monitors) manager.stop(monitor.id)
    const stopMs = now() - stopAt
    const allGone = await waitFor(() => monitors.every((m) => !groupAlive(m.pid)), 2_000)
    const cleanupMs = now() - stopAt

    report("lifecycle.100-monitors", {
      startAllMs: round(startMs),
      perStartMs: round(startMs / 100),
      stopAllMs: round(stopMs),
      allProcessesGoneWithinMs: round(cleanupMs),
      allGone,
    })

    expect(allGone).toBe(true)
    expect(startMs).toBeLessThan(2_000)
    expect(cleanupMs).toBeLessThan(2_000)
  })
})

describe("hostile output", () => {
  test("a 32 MB line with no newline does not balloon memory or stall the server", async () => {
    Bun.gc(true)
    const rssBefore = process.memoryUsage().rss
    const lag = trackEventLoopLag()
    const cpu = trackCpu()
    const monitor = watch(emitCommand({ blob: 32 * 1024 * 1024, hold: 500 }))

    await waitFor(() => !isAlive(monitor.pid), 20_000)
    const usage = cpu.stop()
    const loop = summarize(lag.stop())
    const rssGrowthMb = round((process.memoryUsage().rss - rssBefore) / 1024 / 1024)

    await waitFor(() => monitor.deliveries.length > 0, 1_000)
    const delivered = monitor.deliveries.map((d) => d.text).join("\n")
    report("hostile.32mb-no-newline", {
      rssGrowthMb,
      cpu: usage,
      eventLoopLagMs: loop,
      deliveredChars: delivered.length,
    })

    expect(rssGrowthMb).toBeLessThan(16)
    expect(loop.max).toBeLessThan(50)
    expect(delivered).toContain("[line cut at 65536 characters]")
    expect(delivered.length).toBeLessThan(70_000)
  }, 30_000)

  test("a catastrophic filter regex stops the monitor instead of freezing the server", async () => {
    const lag = trackEventLoopLag()
    // (a+)+$ backtracks exponentially on a run of a's that does not end the
    // line; 40 of them would block a thread for days.
    const monitor = watch(`printf '${"a".repeat(40)}b\\n'; sleep 30`, { filter: "(a+)+$" })
    const stopped = await waitFor(() => manager.get(monitor.id) === undefined, 2_000)
    const gone = await waitFor(() => !groupAlive(monitor.pid), 1_000)
    const loop = summarize(lag.stop())
    const notice = monitor.deliveries.find((d) => d.text.includes("took longer than"))

    report("hostile.catastrophic-filter", { eventLoopLagMs: loop, stopped, processGone: gone })

    expect(stopped).toBe(true)
    expect(gone).toBe(true)
    expect(notice).toBeDefined()
    expect(loop.max).toBeLessThan(50)
  }, 10_000)

  test("filtering a steady stream through the worker keeps latency and order", async () => {
    const monitor = watch(emitCommand({ count: 100, rate: 50 }), { filter: "^L \\d*[02468] " })
    await waitFor(() => monitor.lines().length === 50, 6_000)

    const lines = monitor.lines()
    const latency = summarize(lines.map((l) => l.latencyMs))
    report("latency.filtered-50-per-sec", { latencyMs: latency, deliveries: monitor.deliveries.length })

    expect(lines.map((l) => l.seq)).toEqual([...Array(50).keys()].map((i) => i * 2))
    expect(latency.p95).toBeLessThan(BATCH_WINDOW_MS + 100)
  })
})
