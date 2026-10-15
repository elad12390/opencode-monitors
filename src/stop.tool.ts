import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { stopMonitor } from "./lib/core"

export const sentinel_stop = tool({
  description: "Stop a running monitor by its ID. The monitor process will be terminated and its resources freed.",
  args: {
    id: z.string().describe("The monitor ID to stop (returned by sentinel_monitor when started)"),
  },
  async execute(args) {
    return stopMonitor(args.id)
  },
})
