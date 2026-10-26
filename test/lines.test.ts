import { describe, expect, test } from "bun:test"
import { createLineSplitter } from "../src/lib/lines"

describe("createLineSplitter", () => {
  test("joins lines split across chunks", () => {
    const split = createLineSplitter(100)
    expect(split("hel")).toEqual([])
    expect(split("lo\nwor")).toEqual(["hello"])
    expect(split("ld\n")).toEqual(["world"])
  })

  test("cuts a complete line that is longer than the limit", () => {
    const split = createLineSplitter(5)
    expect(split("abcdefgh\nok\n")).toEqual([
      "abcde … [line cut at 5 characters]",
      "ok",
    ])
  })

  test("emits an endless line once, then skips the rest of it up to its newline", () => {
    const split = createLineSplitter(5)
    expect(split("abcdefgh")).toEqual(["abcde … [line cut at 5 characters]"])
    expect(split("more of the same line")).toEqual([])
    expect(split("still going\nnext\n")).toEqual(["next"])
  })
})
