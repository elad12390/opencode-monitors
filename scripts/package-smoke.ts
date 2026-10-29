// Packs the real npm tarball, installs it into a clean project next to the
// packages OpenCode provides to plugins, and loads every entry point through
// its published name: the server plugin ("."), the /monitors popup ("./tui")
// and the RPC contract ("./rpc"). Fails on anything a user installing from npm
// would hit: a missing file, an unbuilt popup, a broken import.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import Arborist from "@npmcli/arborist"

const root = path.join(import.meta.dir, "..")
const pkg = await Bun.file(path.join(root, "package.json")).json()
const work = mkdtempSync(path.join(tmpdir(), "opencode-monitors-smoke-"))

function run(cmd: string[], cwd: string): string {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const out = result.stdout.toString()
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${result.exitCode}):\n${out}${result.stderr.toString()}`)
  }
  return out
}

try {
  // npm pack runs prepack (the popup build) first; its output comes before the JSON.
  const packOutput = run(["npm", "pack", "--json", "--pack-destination", work], root)
  const packed = JSON.parse(packOutput.slice(packOutput.search(/^\[/m)))[0]
  const files: string[] = packed.files.map((f: { path: string }) => f.path)
  console.log(`packed ${packed.filename}: ${files.length} files, ${(packed.size / 1024).toFixed(1)} KB`)

  for (const required of ["dist/tui.js", "src/index.ts", "src/rpc.ts", "src/lib/match-worker.ts", "LICENSE", "README.md", "CHANGELOG.md"]) {
    if (!files.includes(required)) throw new Error(`the tarball is missing ${required}`)
  }
  const unwanted = files.filter((f) => /^(test|test-tui|test-integration|perf|scripts|tmp|docs)\//.test(f) || f.includes("node_modules"))
  if (unwanted.length) throw new Error(`the tarball has files users don't need: ${unwanted.join(", ")}`)

  // OpenCode V2 installs plugins with Arborist running inside Bun, not `bun add`
  // or the system npm CLI. Bun reports a Node version which can make its peer
  // resolver select older OpenTUI packages. Exercise that path with the packed
  // artifact before the host packages are present, as in a fresh installation.
  const resolverProject = path.join(work, "resolver")
  mkdirSync(resolverProject)
  const resolver = new Arborist({
    path: resolverProject,
    audit: false,
    ignoreScripts: true,
    binLinks: true,
    nodeVersion: "v26.3.0",
  })
  await resolver.reify({ add: [path.join(work, packed.filename)] })
  const installed = path.join(resolverProject, "node_modules", pkg.name)
  if (!(await Bun.file(path.join(installed, "src/index.ts")).exists())) {
    throw new Error("OpenCode-style install did not produce the server entry point")
  }
  console.log("  OpenCode-style Bun/Arborist installation passed")

  const project = path.join(work, "project")
  mkdirSync(project)
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }))
  const host = ["@opencode/plugin", "@opentui/core", "@opentui/solid", "solid-js"].map(
    (name) => `${name}@${pkg.devDependencies[name]}`,
  )
  run(["bun", "add", path.join(work, packed.filename), ...host], project)

  writeFileSync(
    path.join(project, "check.ts"),
    `
const server = (await import("opencode-monitors")).default
if (server.id !== "opencode-monitors") throw new Error("server id is " + server.id)
const tools = {}
let rpc
const deliveries = []
const cleanup = await server.setup({
  location: { directory: process.cwd() },
  tool: { transform: async (cb) => cb({ add: (t) => (tools[t.name] = t) }) },
  session: { prompt: async (input) => { deliveries.push(input.text) } },
  rpc: { register: async (_def, handlers) => { rpc = handlers; return { dispose: async () => {}, events: { emit: async () => {} } } } },
})
const names = Object.keys(tools).sort().join(",")
if (names !== "list_monitors,monitor,stop_monitor") throw new Error("tools: " + names)
const started = await tools.monitor.execute({ command: "echo from-the-package", description: "smoke" }, { sessionID: "ses_smoke" })
if (!started.content.startsWith("Started monitor")) throw new Error(started.content)
for (let i = 0; i < 100 && deliveries.length < 2; i++) await Bun.sleep(20)
if (!deliveries.some((d) => d.includes("from-the-package"))) throw new Error("no output delivered: " + JSON.stringify(deliveries))
if (!deliveries.some((d) => d.includes("finished: the command exited with code 0"))) throw new Error("no end notice: " + JSON.stringify(deliveries))
const listed = await rpc.list({}, {})
if (listed.monitors[0]?.description !== "smoke") throw new Error("rpc list: " + JSON.stringify(listed))
cleanup()

const tui = (await import("opencode-monitors/tui")).default
if (tui.id !== "opencode-monitors.tui") throw new Error("tui id is " + tui.id)
let command
tui.setup({
  client: { rpc: () => ({ events: { on: () => () => {} } }) },
  storage: { store: () => [{ scope: "all" }, async () => {}] },
  keymap: { layer: (factory) => { command = factory().commands[0] } },
  ui: {}, theme: {}, data: {},
})
if (command?.slash?.name !== "monitors") throw new Error("no /monitors command: " + JSON.stringify(command))

const { MonitorsRpc } = await import("opencode-monitors/rpc")
if (MonitorsRpc.id !== "monitors") throw new Error("rpc id is " + MonitorsRpc.id)
console.log("server: tools " + names + ", delivered output and end notice, rpc list ok")
console.log("tui: /monitors command registered from dist/tui.js")
console.log("rpc: contract id " + MonitorsRpc.id)
`,
  )
  console.log(
    run(["bun", "check.ts"], project)
      .trim()
      .replace(/^/gm, "  "),
  )
  console.log("package smoke test passed")
} finally {
  rmSync(work, { recursive: true, force: true })
}
