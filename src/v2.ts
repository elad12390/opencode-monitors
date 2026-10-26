import { listMonitors, startMonitor, stopMonitor } from "./lib/core"
import { manager } from "./lib/manager"
import { announcePending, recoverMonitors } from "./lib/recovery"
import { createFileStore, type MonitorStore } from "./lib/state"
import description from "./monitor.txt" with { type: "text" }

let store: MonitorStore | undefined
/** One state-file store per process, created on first use so tests can point it elsewhere first. */
function stateStore(): MonitorStore {
  store ??= createFileStore()
  return store
}

/**
 * The subset of the OpenCode V2 plugin context this plugin relies on. Typed
 * structurally (rather than importing the `@opencode/plugin` types) so the V2
 * path has no external runtime or type dependency and loads cleanly.
 */
interface V2ToolDefinition {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (
    input: any,
    context: { sessionID: string },
  ) => Promise<{ content: string }>
}

interface V2Context {
  location?: { directory?: string }
  tool: {
    transform: (
      callback: (editor: { add: (tool: V2ToolDefinition) => void }) => void,
    ) => Promise<unknown>
  }
  session: {
    prompt: (input: {
      sessionID: string
      text: string
      delivery?: "steer" | "queue"
    }) => Promise<unknown>
  }
  event: {
    subscribe: (options: {
      signal: AbortSignal
    }) => AsyncIterable<{
      type: string
      data?: { sessionID?: string }
      properties?: { sessionID?: string }
    }>
  }
  rpc?: {
    register: (definition: unknown, handlers: Record<string, RpcHandler>) => Promise<{
      dispose: () => Promise<void>
      events: { emit: (name: string, data: Record<string, unknown>) => Promise<void> }
    }>
  }
}

type RpcHandler = (
  input: any,
  context: { error: (type: string, message: string, data?: unknown) => unknown },
) => Promise<unknown>

/** Coalesces monitor changes into at most one `changed` event per monitor every 250 ms. */
const CHANGE_EVENT_INTERVAL_MS = 250

function asJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

async function registerRpc(ctx: V2Context): Promise<() => void> {
  if (typeof ctx.rpc?.register !== "function") return () => {}
  const { SentinelRpc } = await import("./rpc")
  const notFound = (context: Parameters<RpcHandler>[1], id: string) =>
    context.error("not_found", `Monitor not found: ${id}`, { id })

  const registration = await ctx.rpc.register(SentinelRpc, {
    // OpenCode validates the output against the schema and rejects a key that
    // is present with an undefined value, so send what JSON would carry.
    list: async () => ({ monitors: asJson(manager.all()) }),
    logs: async ({ id, limit }, context) => {
      const lines = manager.logs(id, limit)
      return lines ? { lines: asJson(lines) } : notFound(context, id)
    },
    // Only /monitors calls this, so the user is the one stopping it.
    stop: async ({ id }, context) => {
      if (manager.get(id)) {
        manager.stop(id, "stopped", "user")
        return { stopped: true }
      }
      return manager.logs(id) ? { stopped: false } : notFound(context, id)
    },
  })

  const changedIDs = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const unsubscribe = manager.onChange((id) => {
    changedIDs.add(id)
    timer ??= setTimeout(() => {
      timer = undefined
      for (const changed of changedIDs) {
        void registration.events.emit("changed", { id: changed }).catch(() => {})
      }
      changedIDs.clear()
    }, CHANGE_EVENT_INTERVAL_MS)
  })

  return () => {
    unsubscribe()
    if (timer) clearTimeout(timer)
    void registration.dispose().catch(() => {})
  }
}

const MONITOR_INPUT = {
  type: "object",
  properties: {
    command: {
      type: "string",
      description:
        "Shell command to execute and watch (e.g., 'tail -f /var/log/app.log | grep --line-buffered ERROR')",
    },
    description: {
      type: "string",
      description: "Human-readable label shown in monitor notifications",
    },
    filter: {
      type: "string",
      minLength: 1,
      description:
        "JavaScript regular expression. Only stdout lines matching this regex are notified; non-matching lines are silently dropped.",
    },
    until: {
      type: "string",
      minLength: 1,
      description:
        'JavaScript regular expression. When a line matches (after filter, if set), the line is notified and the monitor auto-stops. Useful for one-shot wait patterns like "wake me when CI finishes".',
    },
  },
  required: ["command", "description"],
  additionalProperties: false,
} as const

const EMPTY_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const

/**
 * V2 plugin implementation (OpenCode 2.x plugin API).
 *
 * On OpenCode 1.18.x a V2-preview runtime also calls `setup()` with a partial
 * context that lacks `tool`/`session`/`event`. We no-op there and let the V1
 * `server` path (which runs in the same host) handle everything.
 */
export async function v2Setup(
  rawCtx: unknown,
): Promise<void | (() => void)> {
  const ctx = rawCtx as V2Context | undefined
  if (
    typeof ctx?.tool?.transform !== "function" ||
    typeof ctx?.session?.prompt !== "function"
  ) {
    return
  }

  // OpenCode sets the plugin up once per open project. Monitors remember
  // which setup started them, so unloading one project stops only its own.
  const owner = crypto.randomUUID()
  const directory = ctx.location?.directory
  const deliverTo = (sessionID: string) => async (text: string) => {
    await ctx.session.prompt({ sessionID, text, delivery: "steer" })
  }

  recoverMonitors({ manager, store: stateStore() })
  const cancelAnnounce = announcePending({ manager, directory, deliverTo })

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "sentinel_monitor",
      description,
      input: MONITOR_INPUT,
      async execute(input: any, context) {
        const sessionID = context.sessionID
        // On V2 an explicit `delivery: "steer"` reaches both idle and running
        // sessions (verified on 2.0.29), so no parts fallback is needed.
        return {
          content: startMonitor({
            command: input.command,
            description: input.description,
            filter: input.filter,
            until: input.until,
            sessionID,
            deliver: deliverTo(sessionID),
            directory,
            owner,
          }),
        }
      },
    })

    editor.add({
      name: "sentinel_stop",
      description:
        "Stop a running monitor by its ID. The monitor process will be terminated and its resources freed.",
      input: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "The monitor ID to stop (returned by sentinel_monitor when started)",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(input: any) {
        return { content: stopMonitor(input.id) }
      },
    })

    editor.add({
      name: "sentinel_list",
      description:
        "List all currently running monitors with their status (ID, description, command, started time, lines emitted).",
      input: EMPTY_INPUT,
      async execute() {
        return { content: listMonitors() }
      },
    })

    editor.add({
      name: "sentinel_ping",
      description:
        "Health check for the sentinel plugin. Returns pong if the plugin is loaded and operational.",
      input: EMPTY_INPUT,
      async execute() {
        return { content: "pong" }
      },
    })
  })

  const disposeRpc = await registerRpc(ctx)

  const controller = new AbortController()
  if (typeof ctx.event?.subscribe === "function") {
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          if (event.type === "session.deleted") {
            // V2 delivers events shaped as { type, data: <payload> }.
            const sessionID =
              event.data?.sessionID ?? event.properties?.sessionID
            if (typeof sessionID === "string") {
              manager.disposeSession(sessionID)
            }
          }
        }
      } catch {
        // Subscription aborted during cleanup, or the host ended the stream.
      }
    })()
  }

  return () => {
    controller.abort()
    disposeRpc()
    cancelAnnounce()
    manager.disposeOwner(owner)
  }
}
