import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { startMonitor } from "../src/lib/core"
import { manager } from "../src/lib/manager"

const EMIT = path.join(import.meta.dir, "fixtures", "emit.ts")
const REPORT = path.join(import.meta.dir, "..", "tmp", "perf", "latest.json")

export const now = () => performance.timeOrigin + performance.now()

/** Shell command that runs the line generator with the given options. */
export function emitCommand(options: Record<string, number>): string {
  const flags = Object.entries(options)
    .map(([key, value]) => `--${key} ${value}`)
    .join(" ")
  return `"${process.execPath}" "${EMIT}" ${flags}`
}

export interface Delivery {
  at: number
  text: string
}

export interface ReceivedLine {
  seq: number
  latencyMs: number
}

/** Starts a real monitor and records every delivery it makes. */
export function watch(command: string, options: { filter?: string; until?: string } = {}) {
  const deliveries: Delivery[] = []
  const result = startMonitor({
    command,
    description: "perf",
    sessionID: "ses_perf",
    filter: options.filter,
    until: options.until,
    deliver: async (text) => {
      deliveries.push({ at: now(), text })
    },
  })
  const match = result.match(/Started monitor (\S+)/)
  if (!match) throw new Error(`monitor did not start: ${result}`)
  const id = match[1]
  const pid = manager.get(id)?.proc.pid
  if (!pid) throw new Error(`monitor ${id} has no pid`)

  const lines = (): ReceivedLine[] =>
    deliveries.flatMap((delivery) =>
      [...delivery.text.matchAll(/L (\d+) ([\d.]+)/g)].map((m) => ({
        seq: Number(m[1]),
        latencyMs: delivery.at - Number(m[2]),
      })),
    )

  return { id, pid, deliveries, lines }
}

export async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  intervalMs = 10,
): Promise<boolean> {
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    if (condition()) return true
    await Bun.sleep(intervalMs)
  }
  return condition()
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

export function summarize(values: number[]) {
  return {
    count: values.length,
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    p99: round(percentile(values, 99)),
    max: round(Math.max(...values)),
  }
}

/** Samples how late a 10 ms timer fires, which is how long the event loop was blocked. */
export function trackEventLoopLag() {
  const lags: number[] = []
  let expected = now() + 10
  const timer = setInterval(() => {
    const at = now()
    lags.push(Math.max(0, at - expected))
    expected = at + 10
  }, 10)
  return {
    stop() {
      clearInterval(timer)
      return lags
    },
  }
}

/** CPU time this process spent in a window, as a share of one core. */
export function trackCpu() {
  const startCpu = process.cpuUsage()
  const startAt = now()
  return {
    stop() {
      const used = process.cpuUsage(startCpu)
      const cpuMs = (used.user + used.system) / 1000
      const wallMs = now() - startAt
      return { cpuMs: round(cpuMs), wallMs: round(wallMs), corePercent: round((cpuMs / wallMs) * 100) }
    },
  }
}

export function round(value: number): number {
  return Math.round(value * 10) / 10
}

/** Prints a scenario's numbers and merges them into tmp/perf/latest.json. */
export function report(scenario: string, metrics: Record<string, unknown>) {
  console.log(`\n[perf] ${scenario}\n${JSON.stringify(metrics, null, 2)}`)
  mkdirSync(path.dirname(REPORT), { recursive: true })
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(readFileSync(REPORT, "utf8"))
  } catch {}
  existing[scenario] = { ...metrics, recordedAt: new Date().toISOString() }
  writeFileSync(REPORT, JSON.stringify(existing, null, 2) + "\n")
}
