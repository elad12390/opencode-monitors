import { describe, expect, test } from "bun:test"
import { createMatcher, MatchTimeoutError } from "../src/lib/matcher"

describe("createMatcher", () => {
  test("applies filter first, then until", async () => {
    const matcher = createMatcher({ filter: "ERROR", until: "DONE" })
    try {
      expect(await matcher.match("INFO ok")).toEqual({ keep: false, stop: false })
      expect(await matcher.match("ERROR bad")).toEqual({ keep: true, stop: false })
      expect(await matcher.match("DONE but not an error")).toEqual({ keep: false, stop: false })
      expect(await matcher.match("ERROR DONE")).toEqual({ keep: true, stop: true })
    } finally {
      matcher.dispose()
    }
  })

  test("answers in the order lines were sent", async () => {
    const matcher = createMatcher({ filter: "^keep" })
    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => matcher.match(i % 2 ? "keep" : "drop")),
      )
      expect(results.map((r) => r.keep)).toEqual(
        Array.from({ length: 50 }, (_, i) => i % 2 === 1),
      )
    } finally {
      matcher.dispose()
    }
  })

  test("gives up on a catastrophic pattern without blocking this thread", async () => {
    const matcher = createMatcher({ filter: "(a+)+$", timeoutMs: 100 })
    const startedAt = performance.now()
    let lastTick = startedAt
    let longestGap = 0
    const ticker = setInterval(() => {
      const at = performance.now()
      longestGap = Math.max(longestGap, at - lastTick)
      lastTick = at
    }, 5)

    const error = await matcher.match("a".repeat(40) + "b").catch((e) => e)
    clearInterval(ticker)

    expect(error).toBeInstanceOf(MatchTimeoutError)
    expect(performance.now() - startedAt).toBeLessThan(1_000)
    expect(longestGap).toBeLessThan(50)
  })
})
