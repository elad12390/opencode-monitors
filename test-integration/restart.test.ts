import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { MonitorManager, manager } from "../src/lib/manager"
import { announcePending, recoverMonitors } from "../src/lib/recovery"
import { createFileStore } from "../src/lib/state"
import { v2Setup } from "../src/v2"

// Real processes throughout: a host process that is SIGKILLed like a crashed
// OpenCode, the monitor process it leaves behind, and the real state file.

const HOST = path.join(import.meta.dir, "fixtures", "crashing-host.ts")

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(condition: () => boolean, ms = 3_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (condition()) return true
    await Bun.sleep(20)
  }
  return condition()
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  manager.dispose()
})

async function crashHostWithMonitor(file: string) {
  const host = Bun.spawn([process.execPath, HOST], {
    env: { ...process.env, SENTINEL_STATE_FILE: file },
    stdout: "pipe",
  })
  const reader = host.stdout.getReader()
  let output = ""
  while (!output.includes("\n")) {
    const { value, done } = await reader.read()
    if (done) break
    output += new TextDecoder().decode(value)
  }
  const [, id, pid] = output.trim().split(" ")
  host.kill("SIGKILL")
  await host.exited
  return { id, monitorPid: Number(pid), hostPid: host.pid }
}

describe("OpenCode restarts", () => {
  test("after a crash, the next start kills the orphaned monitor and tells its session it must be restarted", async () => {
    const file = path.join(tmpdir(), `sentinel-restart-${process.pid}-${Date.now()}.json`)
    cleanups.push(() => rmSync(file, { force: true }))

    const { id, monitorPid, hostPid } = await crashHostWithMonitor(file)
    expect(alive(hostPid)).toBe(false)
    // The crash left the monitored command running with nobody reading it.
    expect(alive(monitorPid)).toBe(true)
    cleanups.push(() => {
      try {
        process.kill(-monitorPid, "SIGKILL")
      } catch {}
    })

    const restarted = new MonitorManager()
    const ended = recoverMonitors({ manager: restarted, store: createFileStore(file) })
    expect(ended).toEqual([id])
    expect(await until(() => !alive(monitorPid))).toBe(true)

    const told: { sessionID: string; text: string }[] = []
    announcePending({
      manager: restarted,
      directory: "/work/crash",
      deliverTo: (sessionID) => async (text) => {
        told.push({ sessionID, text })
      },
      delayMs: 0,
    })
    expect(await until(() => told.length === 1)).toBe(true)
    expect(told[0].sessionID).toBe("ses_crash")
    expect(told[0].text).toContain(`[monitor:${id}] "crash survivor" stopped because OpenCode restarted`)
    expect(told[0].text).toContain(`start it again with monitor (command: "sleep 300")`)

    const state = JSON.parse(readFileSync(file, "utf8"))
    expect(state).toEqual([
      expect.objectContaining({ id, status: "stopped", endReason: "restart", notice: "sent", ownerPid: process.pid }),
    ])
  }, 15_000)

  test("a process that only reuses the monitor's PID is never killed", async () => {
    const file = path.join(tmpdir(), `sentinel-reuse-${process.pid}-${Date.now()}.json`)
    cleanups.push(() => rmSync(file, { force: true }))
    const { monitorPid } = await crashHostWithMonitor(file)
    process.kill(-monitorPid, "SIGKILL")
    await until(() => !alive(monitorPid))

    // Something else now holds a PID the state file points at.
    const bystander = Bun.spawn(["sleep", "30"])
    cleanups.push(() => bystander.kill("SIGKILL"))
    const store = createFileStore(file)
    store.save(store.read().map((r) => ({ ...r, pid: bystander.pid })))

    recoverMonitors({ manager: new MonitorManager(), store })
    await Bun.sleep(100)
    expect(alive(bystander.pid)).toBe(true)
  }, 15_000)
})

describe("unloading the plugin", () => {
  function host(directory: string) {
    const prompts: { sessionID: string; text: string }[] = []
    let tools: Record<string, any> = {}
    const ctx = {
      location: { directory },
      tool: {
        transform: async (cb: any) =>
          cb({
            add: (tool: any) => {
              tools[tool.name] = tool
            },
          }),
      },
      session: {
        prompt: async (input: any) => {
          prompts.push({ sessionID: input.sessionID, text: input.text })
        },
      },
    }
    return { ctx, prompts, tools: () => tools }
  }

  test("unloading in one project stops only that project's monitors and tells their sessions", async () => {
    const api = host("/work/api")
    const web = host("/work/web")
    const disposeApi = (await v2Setup(api.ctx)) as () => void
    const disposeWeb = (await v2Setup(web.ctx)) as () => void
    cleanups.push(disposeWeb)

    await api.tools().monitor.execute({ command: "sleep 30", description: "api watch" }, { sessionID: "ses_api" })
    await web.tools().monitor.execute({ command: "sleep 30", description: "web watch" }, { sessionID: "ses_web" })
    const [webMonitor, apiMonitor] = manager.all()
    const apiPid = apiMonitor.pid!

    disposeApi()
    expect(await until(() => !alive(apiPid))).toBe(true)
    expect(await until(() => api.prompts.length === 1)).toBe(true)

    expect(api.prompts[0]).toEqual({
      sessionID: "ses_api",
      text: `[monitor:${apiMonitor.id}] "api watch" stopped because the monitors plugin was unloaded or OpenCode shut down. It is no longer running. If you still need it, start it again with monitor (command: "sleep 30").`,
    })
    expect(manager.all().find((m) => m.id === webMonitor.id)?.status).toBe("running")
    expect(alive(webMonitor.pid!)).toBe(true)
    expect(web.prompts).toEqual([])
  }, 15_000)

  test("a command that finishes on its own tells the agent, after its last output", async () => {
    const api = host("/work/api")
    cleanups.push((await v2Setup(api.ctx)) as () => void)

    await api.tools().monitor.execute(
      { command: "echo build done", description: "build" },
      { sessionID: "ses_api" },
    )
    expect(await until(() => api.prompts.length === 2)).toBe(true)
    const id = manager.all()[0].id
    expect(api.prompts.map((p) => p.text)).toEqual([
      `[monitor:${id}] build done`,
      `[monitor:${id}] "build" finished: the command exited with code 0. It is no longer running.`,
    ])
  }, 15_000)
})
