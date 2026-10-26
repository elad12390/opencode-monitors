import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import { createLineSplitter } from "./lines"
import type { MonitorManager } from "./manager"
import { createMatcher, MatchTimeoutError } from "./matcher"

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
  const matcher =
    params.filter || params.until
      ? createMatcher({ filter: params.filter, until: params.until })
      : null
  const splitLines = createLineSplitter()
  // Lines that need the matcher are handled one after another on this chain,
  // so they reach the agent in the order the command wrote them.
  let matching: Promise<void> = Promise.resolve()

  const proc = spawn(params.command, {
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SENTINEL_SESSION_ID: params.sessionID },
  })

  let batchBuffer: string[] = []
  let batchTimer: ReturnType<typeof setTimeout> | null = null
  // Set once the watcher stops itself (flood or until). Output that is still
  // in the pipe after that point is ignored instead of stopping it again.
  let selfStopped = false

  function stopSelf() {
    selfStopped = true
    if (proc.pid) {
      try {
        process.kill(-proc.pid, "SIGTERM")
      } catch {}
    }
    if (params.manager.get(params.id)) params.manager.stop(params.id)
  }

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

  /** Queues a line that passed the filter, or stops the monitor when it matched `until`. */
  function accept(line: string, matchedUntil: boolean) {
    // until is evaluated on the filter-surviving stream, so filter+until compose as a pipeline.
    if (matchedUntil) {
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
      stopSelf()
      return
    }

    batchBuffer.push(line)
    if (!batchTimer) {
      batchTimer = setTimeout(flushBatch, 200)
    }
  }

  function acceptWhenMatched(line: string) {
    matching = matching.then(async () => {
      if (selfStopped) return
      let result
      try {
        result = await matcher!.match(line)
      } catch (err) {
        if (err instanceof MatchTimeoutError && !selfStopped) {
          notify(
            `[monitor:${params.id}] ${err.message}. Monitor auto-stopped; use a simpler pattern.`,
            "slow-regex",
          )
          stopSelf()
        }
        return
      }
      if (selfStopped || !result.keep) return
      accept(line, result.stop)
    })
  }

  proc.stdout!.on("data", async (chunk: Buffer) => {
    if (selfStopped) return

    for (const line of splitLines(chunk.toString())) {
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
        notify(
          `[monitor:${params.id}] FLOOD DETECTED: ${lineTimestamps.length} lines/sec exceeds limit of ${MAX_LINES_PER_SEC}. Monitor auto-stopped.`,
          "flood",
        )
        stopSelf()
        return
      }

      if (matcher) acceptWhenMatched(line)
      else accept(line, false)
    }
  })

  proc.stderr!.on("data", (chunk: Buffer) => {
    const logPath = `/tmp/sentinel-${params.id}-stderr.log`
    fs.appendFileSync(logPath, chunk.toString())
  })

  proc.on("exit", async (code) => {
    await matching
    matcher?.dispose()
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
