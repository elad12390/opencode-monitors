import { v2Setup } from "./v2"

/**
 * Dual-entrypoint plugin.
 *
 * - OpenCode V2 (2.x) loads the object form: it reads `id` and calls `setup(ctx)`.
 * - OpenCode V1 loads a server function: it calls `server(input, options)`.
 *
 * Both V1 and V2 share the same monitor core (`./lib/core`); the entrypoints are
 * thin adapters that translate host APIs. The V1 implementation is imported
 * lazily so that a V2 host never has to resolve the V1 packages it does not
 * provide (`@opencode-ai/plugin`, `@opencode-ai/sdk`, `zod`).
 */
export default {
  id: "opencode-sentinel",

  setup: v2Setup,

  async server(input: unknown, options?: unknown) {
    const { v1Server } = await import("./v1")
    return v1Server(input, options)
  },
}
