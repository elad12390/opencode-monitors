import { spawn, type ChildProcess } from "node:child_process"
import { createLineSplitter } from "./lines"
import type { Deliver, MonitorManager, StopReason } from "./manager"
import { createMatcher, MatchTimeoutError } from "./matcher"

export type { Deliver } from "./manager"

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
  const splitErrorLines = createLineSplitter()
  // Lines that need the matcher are handled one after another on this chain,
  // so they reach the agent in the order the command wrote them.
  let matching: Promise<void> = Promise.resolve()

  const proc = spawn(params.command, {
    shell: true,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    // SENTINEL_SESSION_ID keeps scripts written for opencode-sentinel working.
    env: { ...process.env, MONITOR_SESSION_ID: params.sessionID, SENTINEL_SESSION_ID: params.sessionID },
  })

  let batchBuffer: string[] = []
  let batchTimer: ReturnType<typeof setTimeout> | null = null
  // Set once the watcher stops itself (flood or until). Output that is still
  // in the pipe after that point is ignored instead of stopping it again.
  let selfStopped = false

  function stopSelf(reason: StopReason) {
    selfStopped = true
    if (proc.pid) {
      try {
        process.kill(-proc.pid, "SIGTERM")
      } catch {}
    }
    if (params.manager.get(params.id)) params.manager.stop(params.id, reason)
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
        `[opencode-monitors] ${label} notify failed for ${params.id}:`,
        err,
      )
    })
  }

  function flushBatch(): Promise<void> {
    if (batchBuffer.length === 0) return Promise.resolve()
    const text = batchBuffer
      .map((line) => `[monitor:${params.id}] ${line}`)
      .join("\n")
    batchBuffer = []
    batchTimer = null
    // Callers on the stream don't wait for it; the exit handler does.
    return notify(text, "batch")
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
      stopSelf("until")
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
        if (selfStopped) return
        if (err instanceof MatchTimeoutError) {
          notify(
            `[monitor:${params.id}] ${err.message}. Monitor auto-stopped; use a simpler pattern.`,
            "slow-regex",
          )
          stopSelf("slow-filter")
        } else if (params.manager.get(params.id)) {
          notify(
            `[monitor:${params.id}] filter/until could not run: ${err instanceof Error ? err.message : err}. Monitor auto-stopped.`,
            "filter-error",
          )
          stopSelf("filter-error")
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
      params.manager.appendLog(params.id, "stdout", line)

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
        stopSelf("flood")
        return
      }

      if (matcher) acceptWhenMatched(line)
      else accept(line, false)
    }
  })

  // stderr stays in memory: /monitors shows it, and a failure notice quotes
  // its last lines. Nothing is written to disk.
  proc.stderr!.on("data", (chunk: Buffer) => {
    for (const line of splitErrorLines(chunk.toString())) {
      if (line.trim()) params.manager.appendLog(params.id, "stderr", line)
    }
  })

  // The last output reaches the agent before the manager reports how the
  // command ended (see notices.ts).
  proc.on("exit", async (code, signal) => {
    await matching
    matcher?.dispose()
    if (batchTimer) {
      clearTimeout(batchTimer)
      batchTimer = null
    }
    await flushBatch()
    params.manager.exited(params.id, code, signal)
  })

  return proc
}
