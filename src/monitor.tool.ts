import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { startMonitor } from "./lib/core"
import { MONITOR } from "./tools"

export function createMonitorTool(v2Client: any) {
  return tool({
    description: MONITOR.description,
    args: {
      command: z.string().min(1).describe(MONITOR.params.command),
      description: z.string().min(1).describe(MONITOR.params.description),
      filter: z.string().min(1).optional().describe(MONITOR.params.filter),
      until: z.string().min(1).optional().describe(MONITOR.params.until),
    },
    async execute(args, ctx) {
      const sessionID = ctx.sessionID
      // V1 delivers via the parts/message route: on V1 the steer delivery is
      // admitted but never promoted on an idle session, so only this route
      // reaches the session in every state.
      const deliver = async (text: string) => {
        const result = await v2Client.session.prompt({
          sessionID,
          parts: [{ type: "text", text }],
        })
        if (result?.error) {
          throw new Error(
            typeof result.error === "string"
              ? result.error
              : JSON.stringify(result.error),
          )
        }
      }
      return startMonitor({
        command: args.command,
        description: args.description,
        filter: args.filter,
        until: args.until,
        sessionID,
        deliver,
      })
    },
  })
}
