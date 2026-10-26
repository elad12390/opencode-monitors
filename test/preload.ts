// Every test run gets its own state file, so tests never read or write the
// real ~/.local/state/opencode-sentinel/monitors.json.
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const file = path.join(tmpdir(), `sentinel-test-state-${process.pid}.json`)
process.env.SENTINEL_STATE_FILE ??= file
process.on("exit", () => rmSync(file, { force: true }))
