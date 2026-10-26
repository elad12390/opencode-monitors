import { describe, expect, test } from "bun:test"
import { LIST_MONITORS, MONITOR, STOP_MONITOR } from "../src/tools"
import { v2Setup } from "../src/v2"

// Every tool tells the agent what it does, why to use it, when (and when
// not), and how, in that order, the same way on V1 and V2.

const TOOLS = [MONITOR, STOP_MONITOR, LIST_MONITORS]

describe("tool descriptions", () => {
  test.each(TOOLS.map((t) => [t.name, t]))("%s says what, why, when and how, in that order", (_name, tool) => {
    const labels = tool.description.split("\n").map((line) => line.split(":")[0])
    expect(labels).toEqual(["What", "Why", "When", "How"])
    for (const line of tool.description.split("\n")) {
      expect(line.slice(line.indexOf(":") + 1).trim().length).toBeGreaterThan(10)
    }
  })

  test.each(TOOLS.map((t) => [t.name, t]))("%s names its tools by what they do, in snake_case", (_name, tool) => {
    expect(tool.name).toMatch(/^[a-z]+(_[a-z]+)*$/)
  })

  test("every parameter is explained with an example", () => {
    const params = { ...MONITOR.params, ...STOP_MONITOR.params }
    for (const [name, text] of Object.entries(params)) {
      expect(text, name).toContain("e.g.")
    }
  })

  test("the V2 plugin registers exactly these names and descriptions", async () => {
    const registered: { name: string; description: string; input: any }[] = []
    await v2Setup({
      tool: { transform: async (cb: any) => cb({ add: (t: any) => registered.push(t) }) },
      session: { prompt: async () => ({}) },
    })
    expect(registered.map((t) => [t.name, t.description])).toEqual(TOOLS.map((t) => [t.name, t.description]))
    const monitorInput = registered.find((t) => t.name === "monitor")!.input
    expect(monitorInput.properties.filter.description).toBe(MONITOR.params.filter)
    const stopInput = registered.find((t) => t.name === "stop_monitor")!.input
    expect(Object.keys(stopInput.properties)).toEqual(["monitor"])
  })
})
