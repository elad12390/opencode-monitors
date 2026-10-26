import { tool } from "@opencode-ai/plugin"
import { listMonitors } from "./lib/core"

export const list_monitors = tool({
  description: "List all currently running monitors with their status (ID, description, command, started time, lines emitted).",
  args: {},
  async execute() {
    return listMonitors()
  },
})
