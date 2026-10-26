import { describe, expect, test } from "bun:test"
import { LIST_MONITORS, MONITOR, STOP_MONITOR } from "../src/tools"
import { v2Setup } from "../src/v2"

// Every tool's description is one short paragraph that tells the agent what
// it does, why and when to use it (and when not), and how, the same way on V1
// and V2.

const TOOLS = [MONITOR, STOP_MONITOR, LIST_MONITORS]

describe("tool descriptions", () => {
  test.each(TOOLS.map((t) => [t.name, t]))("%s is one short paragraph without section labels", (_name, tool) => {
    expect(tool.description).not.toContain("\n")
    expect(tool.description).not.toMatch(/\b(What|Why|When|How):/)
    expect(tool.description.length).toBeLessThan(1_000)
  })

  test.each(TOOLS.map((t) => [t.name, t]))("%s says when to use it", (_name, tool) => {
    expect(tool.description).toContain("Use it ")
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
