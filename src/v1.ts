import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { createMonitorTool } from "./monitor.tool"
import { list_monitors } from "./list.tool"
import { stop_monitor } from "./stop.tool"
import { manager } from "./lib/manager"

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
      monitor: createMonitorTool(v2),

      stop_monitor,

      list_monitors,
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
