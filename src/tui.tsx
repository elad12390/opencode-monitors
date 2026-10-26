/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { SentinelRpc } from "./rpc"
import { MonitorsDialog, paletteFromTheme, type MonitorSource } from "./tui/MonitorsDialog"
import type { LogLine, Monitor } from "./tui/model"

export const MONITORS_COMMAND = "sentinel.monitors"

export default Plugin.define({
  id: "opencode-sentinel.tui",
  setup(context) {
    const rpc = context.client.rpc(SentinelRpc)
    const source: MonitorSource = {
      list: async () => ((await rpc.list({})) as { monitors: Monitor[] }).monitors,
      logs: async (id, limit) => ((await rpc.logs({ id, limit })) as { lines: LogLine[] }).lines,
      stop: async (id) => ((await rpc.stop({ id })) as { stopped: boolean }).stopped,
      onChange: (listener) => rpc.events.on("changed", () => listener()),
    }

    const open = () => {
      context.ui.dialog.show(() => (
        <MonitorsDialog
          source={source}
          palette={() => paletteFromTheme(context.theme)}
          notify={(message, variant) => context.ui.toast.show({ message, variant })}
        />
      ))
      context.ui.dialog.set({ size: "large", centered: true })
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: MONITORS_COMMAND,
          title: "Monitors",
          description: "See background monitors, read their logs and kill them",
          group: "Sentinel",
          palette: true,
          slash: { name: "monitors" },
          run: open,
        },
      ],
    }))
  },
})
