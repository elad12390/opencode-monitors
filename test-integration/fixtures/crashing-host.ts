// Stands in for an OpenCode server: starts one real monitor with the state
// file enabled, prints the monitor's PID, then waits to be killed.
import { startMonitor } from "../../src/lib/core"
import { manager } from "../../src/lib/manager"
import { createFileStore } from "../../src/lib/state"

manager.persistTo(createFileStore(process.env.SENTINEL_STATE_FILE))
const result = startMonitor({
  command: process.env.MONITOR_COMMAND ?? "sleep 300",
  description: "crash survivor",
  sessionID: "ses_crash",
  directory: "/work/crash",
  deliver: async () => {},
})
const id = result.match(/Monitor started: (\S+)/)![1]
console.log(`READY ${id} ${manager.get(id)!.proc!.pid}`)
setInterval(() => {}, 1_000)
