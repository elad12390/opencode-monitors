// Every test run gets its own state file, so tests never read or write the
// real ~/.local/state/opencode-monitors/monitors.json.
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const file = path.join(tmpdir(), `monitors-test-state-${process.pid}.json`)
process.env.OPENCODE_MONITORS_STATE_FILE ??= file
process.on("exit", () => rmSync(file, { force: true }))
