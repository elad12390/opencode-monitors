import { afterEach, describe, expect, test } from "bun:test"
import { manager } from "../src/lib/manager"
import { v2Setup } from "../src/v2"

// Starts the V2 plugin against an in-memory host and calls the RPC handlers it
// registers, with real monitor processes behind them.

function host() {
  let handlers: Record<string, (input: any, context: any) => Promise<any>> = {}
  let definition: any
  const emitted: any[] = []
  let disposed = false
  const ctx = {
    tool: { transform: async (cb: any) => cb({ add: () => {} }) },
    session: { prompt: async () => ({}) },
    rpc: {
      register: async (def: any, impl: any) => {
        definition = def
        handlers = impl
        return {
          dispose: async () => {
            disposed = true
          },
          events: {
            emit: async (name: string, data: any) => {
              emitted.push({ name, data })
            },
          },
        }
      },
    },
  }
  const errorContext = {
    error: (type: string, message: string, data: unknown) => ({ failed: { type, message, data } }),
  }
  return {
    ctx,
    call: (method: string, input: any) => handlers[method](input, errorContext),
    get definition() {
      return definition
    },
    emitted,
    get disposed() {
      return disposed
    },
  }
}

let cleanup: (() => void) | void

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  manager.dispose()
})

async function startMonitor(command: string) {
  const { startMonitor } = await import("../src/lib/core")
  const result = startMonitor({ command, description: "rpc test", sessionID: "ses_rpc", deliver: async () => {} })
  return result.match(/Started monitor (\S+)/)![1]
}

async function until(condition: () => boolean | Promise<boolean>, ms = 3_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await condition()) return
    await Bun.sleep(20)
  }
  throw new Error("condition not met")
}

describe("monitors RPC", () => {
  test("registers the monitors RPC with list, logs and stop", async () => {
    const h = host()
    cleanup = await v2Setup(h.ctx)
    expect(h.definition.id).toBe("monitors")
    expect(Object.keys(h.definition.methods).sort()).toEqual(["list", "logs", "stop"])
  })

  test("list and logs report a running monitor and everything it printed, stderr included", async () => {
    const h = host()
    cleanup = await v2Setup(h.ctx)
    const id = await startMonitor("echo out-line; echo err-line >&2; sleep 5")

    await until(async () => (await h.call("logs", { id })).lines.length === 2)
    const { monitors } = await h.call("list", {})
    const { lines } = await h.call("logs", { id })

    expect(monitors).toHaveLength(1)
    expect(monitors[0]).toMatchObject({ id, status: "running", description: "rpc test", sessionID: "ses_rpc" })
    // OpenCode's output validation rejects keys that are present but undefined.
    expect(monitors).toStrictEqual(JSON.parse(JSON.stringify(monitors)))
    expect(lines).toStrictEqual(JSON.parse(JSON.stringify(lines)))
    expect(lines.map((l: any) => [l.stream, l.text]).sort()).toEqual([
      ["stderr", "err-line"],
      ["stdout", "out-line"],
    ])
  })

  test("stop kills a running monitor and the list shows it as stopped", async () => {
    const h = host()
    cleanup = await v2Setup(h.ctx)
    const id = await startMonitor("sleep 30")
    const pid = manager.get(id)!.proc.pid!

    expect(await h.call("stop", { id })).toEqual({ stopped: true })
    await until(() => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    })
    const { monitors } = await h.call("list", {})
    expect(monitors[0]).toMatchObject({ id, status: "stopped" })

    expect(await h.call("stop", { id })).toEqual({ stopped: false })
  })

  test("a command that exits by itself shows as completed or failed", async () => {
    const h = host()
    cleanup = await v2Setup(h.ctx)
    const ok = await startMonitor("echo done")
    const bad = await startMonitor("exit 3")

    await until(async () => (await h.call("list", {})).monitors.every((m: any) => m.status !== "running"))
    const byID = Object.fromEntries((await h.call("list", {})).monitors.map((m: any) => [m.id, m]))
    expect(byID[ok]).toMatchObject({ status: "completed", exitCode: 0 })
    expect(byID[bad]).toMatchObject({ status: "failed", exitCode: 3 })
  })

  test("unknown monitors are reported as not found", async () => {
    const h = host()
    cleanup = await v2Setup(h.ctx)
    expect(await h.call("logs", { id: "mon_missing" })).toEqual({
      failed: { type: "not_found", message: "Monitor not found: mon_missing", data: { id: "mon_missing" } },
    })
    expect((await h.call("stop", { id: "mon_missing" })).failed.type).toBe("not_found")
  })

  test("changes are announced as coalesced changed events, and unload disposes the RPC", async () => {
    const h = host()
    cleanup = await v2Setup(h.ctx)
    const id = await startMonitor("for i in 1 2 3 4 5; do echo $i; done; sleep 5")

    await until(() => h.emitted.length > 0, 2_000)
    await Bun.sleep(300)
    expect(h.emitted.every((e) => e.name === "changed" && e.data.id === id)).toBe(true)
    // Start plus five log lines happen inside one 250 ms window.
    expect(h.emitted.length).toBeLessThanOrEqual(2)

    cleanup!()
    cleanup = undefined
    await Bun.sleep(10)
    expect(h.disposed).toBe(true)
  })
})
