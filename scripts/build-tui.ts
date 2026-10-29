// Builds dist/tui.js, the /monitors popup as published on npm.
//
// OpenCode compiles the Solid JSX of a plugin loaded from a local folder, but
// not of one installed under node_modules, so the package ships it compiled.
// OpenCode supplies its own copies of these packages to plugins at runtime, so
// they stay external: bundling them would give the popup a second Solid
// runtime that the host's renderer does not drive.
import solidPlugin from "@opentui/solid/bun-plugin"
import { rmSync } from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const HOST_PROVIDED = [
  "@opencode/plugin",
  "@opencode/plugin/*",
  "@opencode/client",
  "@opencode/theme",
  "@opencode/theme/*",
  "@opentui/core",
  "@opentui/solid",
  "solid-js",
  "solid-js/*",
]

rmSync(path.join(root, "dist"), { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: [path.join(root, "src", "tui.tsx")],
  outdir: path.join(root, "dist"),
  naming: "tui.js",
  target: "bun",
  format: "esm",
  sourcemap: "none",
  plugins: [solidPlugin],
  external: HOST_PROVIDED,
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
for (const output of result.outputs) {
  console.log(`built ${path.relative(root, output.path)} (${(output.size / 1024).toFixed(1)} KB)`)
}
