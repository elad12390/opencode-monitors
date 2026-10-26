/** Most time one line may spend in the filter/until regexes. */
export const MATCH_TIMEOUT_MS = 250

export interface LineMatch {
  /** The line passed `filter` (or there is no filter). */
  keep: boolean
  /** The line passed `filter` and matched `until`. */
  stop: boolean
}

export class MatchTimeoutError extends Error {}

/**
 * Tests lines against a monitor's filter/until regexes in a worker thread.
 * Replies arrive in the order lines were sent. If one line takes longer than
 * `timeoutMs`, the worker is terminated and every pending match rejects with
 * `MatchTimeoutError`.
 */
export function createMatcher(options: {
  filter?: string
  until?: string
  timeoutMs?: number
}) {
  const timeoutMs = options.timeoutMs ?? MATCH_TIMEOUT_MS
  const worker = new Worker(new URL("./match-worker.ts", import.meta.url).href)
  worker.postMessage({ type: "init", filter: options.filter, until: options.until })

  const pending = new Map<
    number,
    {
      resolve: (match: LineMatch) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  let nextID = 0
  let closed = false

  function close(error: Error) {
    if (closed) return
    closed = true
    worker.terminate()
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }

  worker.onmessage = (event: MessageEvent<{ id: number } & LineMatch>) => {
    const request = pending.get(event.data.id)
    if (!request) return
    pending.delete(event.data.id)
    clearTimeout(request.timer)
    request.resolve({ keep: event.data.keep, stop: event.data.stop })
  }

  worker.onerror = (event) => {
    close(new Error(`filter worker failed: ${event.message}`))
  }

  return {
    match(line: string): Promise<LineMatch> {
      if (closed) return Promise.reject(new Error("matcher is closed"))
      const id = nextID++
      return new Promise<LineMatch>((resolve, reject) => {
        const timer = setTimeout(() => {
          close(
            new MatchTimeoutError(
              `filter/until regex took longer than ${timeoutMs} ms on one line`,
            ),
          )
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer })
        worker.postMessage({ type: "test", id, line })
      })
    },

    dispose() {
      close(new Error("matcher is closed"))
    },
  }
}
