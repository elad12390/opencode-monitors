import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import type { MonitorManager } from "./manager"

/** Delivers a notification string to the monitored session. */
export type Deliver = (text: string) => Promise<void>

export function startWatcher(params: {
  id: string
  command: string
  sessionID: string
  deliver: Deliver
  manager: MonitorManager
  filter?: string
  until?: string
}): ChildProcess {
  const filterRe = params.filter ? new RegExp(params.filter) : null
  const untilRe = params.until ? new RegExp(params.until) : null

  const proc = spawn(params.command, {
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SENTINEL_SESSION_ID: params.sessionID },
  })

  let buffer = ""
  let batchBuffer: string[] = []
  let batchTimer: ReturnType<typeof setTimeout> | null = null

  const lineTimestamps: number[] = []
  const MAX_LINES_PER_SEC = 100

  // Notifications go through the injected `deliver` function so the watcher is
  // agnostic to the host API version. V1 delivers via the parts/message route
  // (the only route that wakes an idle session there); V2 delivers with an
  // explicit `delivery: "steer"` prompt. The adapter throws on failure.
  function notify(text: string, label: string): Promise<void> {
    return params.deliver(text).catch((err: unknown) => {
      console.error(
        `[sentinel] ${label} notify failed for ${params.id}:`,
        err,
      )
    })
  }

  function flushBatch() {
    if (batchBuffer.length === 0) return
    const text = batchBuffer
      .map((line) => `[monitor:${params.id}] ${line}`)
      .join("\n")
    batchBuffer = []
    batchTimer = null
    // Fire and forget — don't block the stream
    notify(text, "batch")
  }

  proc.stdout!.on("data", async (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split("\n")
    buffer = lines.pop() || "" // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue

      params.manager.incrementLines(params.id)

      const now = Date.now()
      lineTimestamps.push(now)
      while (
        lineTimestamps.length > 0 &&
        lineTimestamps[0] < now - 1000
      ) {
        lineTimestamps.shift()
      }

      if (lineTimestamps.length > MAX_LINES_PER_SEC) {
        if (proc.pid) {
          try {
            process.kill(-proc.pid, "SIGTERM")
          } catch {}
        }
        notify(
          `[monitor:${params.id}] FLOOD DETECTED: ${lineTimestamps.length} lines/sec exceeds limit of ${MAX_LINES_PER_SEC}. Monitor auto-stopped.`,
          "flood",
        )
        params.manager.stop(params.id)
        return
      }

      if (filterRe && !filterRe.test(line)) continue

      // until is evaluated on the filter-surviving stream, so filter+until compose as a pipeline.
      if (untilRe && untilRe.test(line)) {
        batchBuffer.push(line)
        if (batchTimer) {
          clearTimeout(batchTimer)
          batchTimer = null
        }
        flushBatch()
        notify(
          `[monitor:${params.id}] UNTIL MATCHED "${params.until}" — monitor auto-stopped`,
          "until",
        )
        if (proc.pid) {
          try {
            process.kill(-proc.pid, "SIGTERM")
          } catch {}
        }
        params.manager.stop(params.id)
        return
      }

      batchBuffer.push(line)
      if (!batchTimer) {
        batchTimer = setTimeout(flushBatch, 200)
      }
    }
  })

  proc.stderr!.on("data", (chunk: Buffer) => {
    const logPath = `/tmp/sentinel-${params.id}-stderr.log`
    fs.appendFileSync(logPath, chunk.toString())
  })

  proc.on("exit", async (code) => {
    if (batchTimer) {
      clearTimeout(batchTimer)
      batchTimer = null
    }
    if (batchBuffer.length > 0) {
      flushBatch()
    }

    if (code !== 0 && code !== null) {
      await notify(
        `[monitor:${params.id}] process exited unexpectedly with code ${code}`,
        "exit",
      )
    }
  })

  return proc
}
