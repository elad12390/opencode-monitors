import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { stopMonitor } from "./lib/core"
import { STOP_MONITOR } from "./tools"

export const stop_monitor = tool({
  description: STOP_MONITOR.description,
  args: {
    monitor: z.string().min(1).describe(STOP_MONITOR.params.monitor),
  },
  async execute(args) {
    return stopMonitor(args.monitor)
  },
})
