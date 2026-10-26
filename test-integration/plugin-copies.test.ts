import { afterAll, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"

// OpenCode loads a separate copy of the plugin for every open project, each
// with its own module instances. This loads physically separate copies of the
// plugin source in one process the same way, and checks that they behave as
// one: /monitors in any project sees every monitor, and a project opening
// later never kills monitors another project started.

const SOURCE = process.env.SENTINEL_SOURCE_UNDER_TEST ?? path.join(import.meta.dir, "..")
const COPIES = path.join(import.meta.dir, "..", "tmp", `plugin-copies-${process.pid}`)

async function loadCopy(name: string) {
  const dir = path.join(COPIES, name)
  mkdirSync(dir, { recursive: true })
  cpSync(path.join(SOURCE, "src"), path.join(dir, "src"), { recursive: true })
  cpSync(path.join(SOURCE, "index.ts"), path.join(dir, "index.ts"))
  const plugin = (await import(path.join(dir, "index.ts"))).default

  const tools: Record<string, any> = {}
  let rpc: Record<string, (input: any, context: any) => Promise<any>> = {}
  const ctx = {
    location: { directory: `/work/${name}` },
    tool: { transform: async (cb: any) => cb({ add: (tool: any) => (tools[tool.name] = tool) }) },
    session: { prompt: async () => ({}) },
    rpc: {
      register: async (_definition: any, handlers: any) => {
        rpc = handlers
        return { dispose: async () => {}, events: { emit: async () => {} } }
      },
    },
  }
  const dispose = (await plugin.setup(ctx)) as () => void
  const errors = { error: (type: string) => ({ failed: type }) }
  return {
    tools,
    list: async () => (await rpc.list({}, errors)).monitors as any[],
    dispose,
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const disposers: (() => void)[] = []
afterAll(() => {
  for (const dispose of disposers) dispose()
  rmSync(COPIES, { recursive: true, force: true })
})

describe("one plugin copy per open project", () => {
  test("every copy sees the same monitors, and a project opening later does not kill them", async () => {
    const api = await loadCopy("api")
    const web = await loadCopy("web")
    disposers.push(api.dispose, web.dispose)

    const started = await api.tools.monitor.execute(
      { command: "sleep 30", description: "api build" },
      { sessionID: "ses_api" },
    )
    const id = started.content.match(/Started monitor (\S+)/)[1]

    // /monitors opened in the web project asks the web copy.
    const seenFromWeb = await web.list()
    expect(seenFromWeb.map((m) => [m.id, m.status, m.directory])).toEqual([[id, "running", "/work/api"]])
    const pid = seenFromWeb[0].pid

    // A third project opens: its copy runs restart recovery.
    const docs = await loadCopy("docs")
    disposers.push(docs.dispose)
    await Bun.sleep(200)
    expect(alive(pid)).toBe(true)
    expect((await docs.list()).map((m) => [m.id, m.status])).toEqual([[id, "running"]])

    const state = JSON.parse(readFileSync(process.env.SENTINEL_STATE_FILE!, "utf8"))
    expect(state.filter((r: any) => r.id === id).map((r: any) => r.status)).toEqual(["running"])

    // Starting another monitor from a different copy keeps the first in the state file.
    await web.tools.monitor.execute({ command: "sleep 30", description: "web dev" }, { sessionID: "ses_web" })
    const after = JSON.parse(readFileSync(process.env.SENTINEL_STATE_FILE!, "utf8"))
    expect(after.map((r: any) => r.description).sort()).toEqual(["api build", "web dev"])
  }, 20_000)

  test("unloading one project's copy stops only that project's monitors", async () => {
    const one = await loadCopy("one")
    const two = await loadCopy("two")
    disposers.push(two.dispose)
    await one.tools.monitor.execute({ command: "sleep 30", description: "one watch" }, { sessionID: "ses_1" })
    await two.tools.monitor.execute({ command: "sleep 30", description: "two watch" }, { sessionID: "ses_2" })

    one.dispose()
    await Bun.sleep(100)
    const byDescription = Object.fromEntries((await two.list()).map((m) => [m.description, m]))
    expect(byDescription["one watch"]).toMatchObject({ status: "stopped", endReason: "unload" })
    expect(byDescription["two watch"].status).toBe("running")
  }, 20_000)
})
