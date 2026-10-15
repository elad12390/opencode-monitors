import { tool } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { createMonitorTool } from "./monitor.tool"
import { sentinel_list } from "./list.tool"
import { sentinel_stop } from "./stop.tool"
import { manager } from "./lib/manager"

interface ToolContext {
  sessionID: string
  abort: AbortSignal
}

/**
 * V1 plugin implementation.
 *
 * Loaded lazily from `server()` in `index.ts` so that none of the V1 packages
 * (`@opencode-ai/plugin`, `@opencode-ai/sdk`, `zod`) have to resolve on a V2
 * host — a V2 host does not provide them (verified empirically).
 */
export async function v1Server(input: any, _options?: unknown) {
  // In TUI / `opencode run` mode there is no TCP server: input.serverUrl is a
  // hardcoded dummy (http://localhost:4096) and the API is only reachable via
  // the in-process fetch wired into input.client. Reuse that client's config
  // (baseUrl + fetch + headers) so the v2 client works in every mode;
  // fall back to serverUrl for older hosts that don't expose _client.
  const hostConfig = input.client?._client?.getConfig?.()
  const v2 = createOpencodeClient(
    hostConfig
      ? { baseUrl: hostConfig.baseUrl, fetch: hostConfig.fetch, headers: hostConfig.headers }
      : { baseUrl: input.serverUrl.toString() },
  )

  return {
    tool: {
      sentinel_monitor: createMonitorTool(v2),

      sentinel_stop,

      sentinel_list,

      sentinel_ping: tool({
        description: "Health check for the sentinel plugin. Returns pong if the plugin is loaded and operational.",
        args: {},
        async execute() {
          return "pong"
        },
      }),

      sentinel_spike: tool({
        description: "Spike test: schedules a delayed message delivery to verify the wake mechanism works. Returns 'scheduled' immediately, then after 3 seconds sends '[spike] hello' to the session as a message.",
        args: {},
        async execute(_args: Record<string, never>, ctx: ToolContext) {
          const sessionID = ctx.sessionID
          setTimeout(async () => {
            try {
              const result = await v2.session.prompt({
                sessionID,
                parts: [{ type: "text", text: "[spike] hello from sentinel — delivery test" }],
              })
              if (result.error) {
                console.error("[sentinel_spike] delivery failed:", result.error)
              }
            } catch (err) {
              console.error("[sentinel_spike] delivery failed:", err)
            }
          }, 3000)
          return "scheduled — message delivery will fire in 3 seconds"
        },
      }),
    },

    dispose: async () => {
      manager.dispose()
    },

    event: async (event: any) => {
      if (event.type === "session.deleted") {
        // V1 delivers events shaped as { type, properties: <payload> }.
        const sessionID = event.data?.sessionID ?? event.properties?.sessionID
        if (typeof sessionID === "string") {
          manager.disposeSession(sessionID)
        }
      }
    },
  }
}
