import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { startMonitor } from "./lib/core"
import description from "./monitor.txt" with { type: "text" }

export function createMonitorTool(v2Client: any) {
  return tool({
    description,
    args: {
      command: z
        .string()
        .describe(
          "Shell command to execute and watch (e.g., 'tail -f /var/log/app.log | grep --line-buffered ERROR')",
        ),
      description: z
        .string()
        .describe("Human-readable label shown in monitor notifications"),
      filter: z
        .string()
        .min(1)
        .optional()
        .describe(
          "JavaScript regular expression. Only stdout lines matching this regex are notified; non-matching lines are silently dropped.",
        ),
      until: z
        .string()
        .min(1)
        .optional()
        .describe(
          'JavaScript regular expression. When a line matches (after filter, if set), the line is notified and the monitor auto-stops. Useful for one-shot wait patterns like "wake me when CI finishes".',
        ),
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
