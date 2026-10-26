import { tool } from "@opencode-ai/plugin"
import { listMonitors } from "./lib/core"
import { LIST_MONITORS } from "./tools"

export const list_monitors = tool({
  description: LIST_MONITORS.description,
  args: {},
  async execute() {
    return listMonitors()
  },
})
