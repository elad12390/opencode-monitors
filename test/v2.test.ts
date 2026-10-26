import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test"
import { EventEmitter } from "node:events"

function createMockProc() {
  const proc = new EventEmitter() as any
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.pid = 12345
  return proc
}

let currentProc = createMockProc()
const spawnCalls: Array<{ command: string; options: any }> = []

mock.module("node:child_process", () => ({
  spawn: (command: string, options: any) => {
    spawnCalls.push({ command, options })
    return currentProc
  },
}))

mock.module("node:fs", () => {
  const fsMock = {
    appendFileSync: () => {},
    existsSync: () => false,
    mkdirSync: () => {},
  }
  return { default: fsMock, ...fsMock }
})

const { v2Setup } = await import("../src/v2")
const { manager } = await import("../src/lib/manager")

interface CapturedTool {
  name: string
  description: string
  input: any
  execute: (input: any, context: any) => Promise<any>
}

function makeCtx() {
  const tools: CapturedTool[] = []
  const promptCalls: any[] = []
  const queue: any[] = []
  let waiter: ((r: IteratorResult<any>) => void) | null = null
  const state = {
    subscribed: false,
    signal: undefined as AbortSignal | undefined,
  }

  const pushEvent = (event: any) => {
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve({ value: event, done: false })
    } else {
      queue.push(event)
    }
  }

  const ctx = {
    tool: {
      transform: async (
        cb: (editor: { add: (t: CapturedTool) => void }) => void,
      ) => {
        cb({ add: (t) => tools.push(t) })
        return {}
      },
    },
    session: {
      prompt: async (input: any) => {
        promptCalls.push(input)
        return {}
      },
    },
    event: {
      subscribe: (opts: { signal: AbortSignal }) => {
        state.subscribed = true
        state.signal = opts.signal
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              if (queue.length > 0) {
                return Promise.resolve({ value: queue.shift(), done: false })
              }
              if (opts.signal.aborted) {
                return Promise.resolve({ value: undefined, done: true })
              }
              return new Promise<IteratorResult<any>>((resolve) => {
                waiter = resolve
                opts.signal.addEventListener(
                  "abort",
                  () => resolve({ value: undefined, done: true }),
                  { once: true },
                )
              })
            },
          }),
        }
      },
    },
  }

  return { ctx, tools, promptCalls, state, pushEvent }
}

function toolByName(tools: CapturedTool[], name: string): CapturedTool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool not found: ${name}`)
  return t
}

describe("v2Setup", () => {
  let origKill: typeof process.kill

  beforeEach(() => {
    origKill = process.kill
    ;(process as any).kill = () => {}
    manager.dispose()
    currentProc = createMockProc()
    spawnCalls.length = 0
  })

  afterEach(() => {
    manager.dispose()
    process.kill = origKill
  })

  test("no-ops on the partial V1-preview context", async () => {
    expect(await v2Setup(undefined)).toBeUndefined()
    expect(await v2Setup({})).toBeUndefined()
    expect(await v2Setup({ tool: {} })).toBeUndefined()
    expect(await v2Setup({ tool: { transform: () => {} } })).toBeUndefined()
    // tool present but session missing → still a no-op
    expect(
      await v2Setup({ tool: { transform: async () => {} } }),
    ).toBeUndefined()
  })

  test("registers monitor, stop_monitor and list_monitors, and returns a disposer", async () => {
    const { ctx, tools } = makeCtx()
    const disposer = await v2Setup(ctx)

    expect(typeof disposer).toBe("function")
    expect(tools.map((t) => t.name).sort()).toEqual([
      "list_monitors",
      "monitor",
      "stop_monitor",
    ])
  })

  test("monitor delivers stdout lines with delivery: steer", async () => {
    const { ctx, tools, promptCalls } = makeCtx()
    await v2Setup(ctx)

    const start = await toolByName(tools, "monitor").execute(
      { command: "echo line", description: "e2e" },
      { sessionID: "ses_v2" },
    )
    expect(start.content).toContain("Started monitor")

    currentProc.stdout.emit("data", Buffer.from("HELLO_V2\n"))
    await new Promise((r) => setTimeout(r, 250))

    expect(promptCalls.length).toBe(1)
    expect(promptCalls[0].delivery).toBe("steer")
    expect(promptCalls[0].sessionID).toBe("ses_v2")
    expect(promptCalls[0].text).toContain("HELLO_V2")
  })

  test("list_monitors and stop_monitor manage monitors", async () => {
    const { ctx, tools } = makeCtx()
    await v2Setup(ctx)

    const start = await toolByName(tools, "monitor").execute(
      { command: "sleep 1", description: "longjob" },
      { sessionID: "ses_v2" },
    )
    const id = start.content.match(/Started monitor (\S+)/)![1]

    const listed = await toolByName(tools, "list_monitors").execute(
      {},
      { sessionID: "ses_v2" },
    )
    expect(listed.content).toContain("longjob")

    const stopped = await toolByName(tools, "stop_monitor").execute(
      { monitor: "longjob" },
      { sessionID: "ses_v2" },
    )
    expect(stopped.content).toBe(`Stopped monitor ${id} "longjob" and killed its command.`)

    const after = await toolByName(tools, "list_monitors").execute(
      {},
      { sessionID: "ses_v2" },
    )
    expect(after.content).toBe("No monitors are running.")
  })

  test("disposer aborts the event subscription and cleans up monitors", async () => {
    const { ctx, tools, state } = makeCtx()
    const disposer = (await v2Setup(ctx)) as () => void

    expect(state.subscribed).toBe(true)
    expect(state.signal!.aborted).toBe(false)

    await toolByName(tools, "monitor").execute(
      { command: "sleep 1", description: "x" },
      { sessionID: "ses_v2" },
    )
    expect(manager.list().length).toBe(1)

    disposer()
    expect(state.signal!.aborted).toBe(true)
    expect(manager.list().length).toBe(0)
  })

  test("session.deleted disposes only that session's monitors", async () => {
    const { ctx, tools, pushEvent } = makeCtx()
    await v2Setup(ctx)

    const a = await toolByName(tools, "monitor").execute(
      { command: "sleep 1", description: "a" },
      { sessionID: "ses_a" },
    )
    const b = await toolByName(tools, "monitor").execute(
      { command: "sleep 1", description: "b" },
      { sessionID: "ses_b" },
    )
    const idA = a.content.match(/Started monitor (\S+)/)![1]
    const idB = b.content.match(/Started monitor (\S+)/)![1]

    pushEvent({ type: "session.deleted", data: { sessionID: "ses_a" } })
    await new Promise((r) => setTimeout(r, 20))

    expect(manager.get(idA)).toBeUndefined()
    expect(manager.get(idB)).toBeDefined()
  })
})
