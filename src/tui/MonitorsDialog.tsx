/** @jsxImportSource @opentui/solid */
import { TextAttributes, type RGBA } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import {
  clock,
  describeError,
  formatCount,
  logWindow,
  reselect,
  statusLabel,
  summary,
  timing,
  type LogLine,
  type Monitor,
  type Tone,
} from "./model"

/** Where the popup reads monitors from; the plugin entry backs it with RPC. */
export interface MonitorSource {
  list(): Promise<Monitor[]>
  logs(id: string, limit: number): Promise<LogLine[]>
  stop(id: string): Promise<boolean>
  onChange?(listener: () => void): () => void
}

export interface Palette {
  text: RGBA
  muted: RGBA
  faint: RGBA
  border: RGBA
  selectedBg: RGBA
  running: RGBA
  success: RGBA
  error: RGBA
  warning: RGBA
}

/** Maps OpenCode's theme tokens onto the colors the popup uses. */
export function paletteFromTheme(theme: any): Palette {
  return {
    text: theme.text.base,
    muted: theme.text.muted,
    faint: theme.text.faint,
    border: theme.border.base,
    selectedBg: theme.background.raised.max,
    running: theme.text.feedback.info.base,
    success: theme.text.feedback.success.base,
    error: theme.text.feedback.error.base,
    warning: theme.text.feedback.warning.base,
  }
}

const LOG_FETCH_LIMIT = 500
const KILL_CONFIRM_MS = 3_000
const MAX_LIST_ROWS = 8

export function MonitorsDialog(props: {
  source: MonitorSource
  palette: () => Palette
  mono?: boolean
  pollMs?: number
  now?: () => number
  notify?: (message: string, variant: "success" | "error" | "info") => void
}) {
  const dimensions = useTerminalDimensions()
  const now = () => (props.now ?? Date.now)()
  const colors = () => props.palette()

  const [monitors, setMonitors] = createSignal<Monitor[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [index, setIndex] = createSignal(0)
  const [logs, setLogs] = createSignal<LogLine[]>([])
  const [expanded, setExpanded] = createSignal(false)
  const [scrollBack, setScrollBack] = createSignal(0)
  const [confirmKill, setConfirmKill] = createSignal<string>()
  const [clockTick, setClockTick] = createSignal(now())

  const selected = createMemo(() => monitors()[index()])

  let refreshing = false
  let queued = false
  let disposed = false
  let confirmTimer: ReturnType<typeof setTimeout> | undefined

  async function refresh() {
    if (refreshing) {
      queued = true
      return
    }
    refreshing = true
    try {
      const previous = selected()
      const next = await props.source.list()
      if (disposed) return
      setMonitors(next)
      setIndex(reselect(next, previous?.id, index()))
      setError(undefined)
      setLoaded(true)
      const current = next[index()]
      if (current) {
        const lines = await props.source.logs(current.id, LOG_FETCH_LIMIT)
        if (!disposed && selected()?.id === current.id) setLogs(lines)
      } else {
        setLogs([])
      }
    } catch (err) {
      if (!disposed) {
        setLoaded(true)
        setError(describeError(err))
      }
    } finally {
      refreshing = false
      setClockTick(now())
      if (queued && !disposed) {
        queued = false
        void refresh()
      }
    }
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), props.pollMs ?? 1_000)
    const unsubscribe = props.source.onChange?.(() => void refresh())
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
      unsubscribe?.()
      if (confirmTimer) clearTimeout(confirmTimer)
    })
  })

  function select(next: number) {
    const count = monitors().length
    if (count === 0) return
    const clamped = Math.min(Math.max(0, next), count - 1)
    if (clamped === index()) return
    setIndex(clamped)
    setLogs([])
    setScrollBack(0)
    setConfirmKill(undefined)
    void refresh()
  }

  async function kill(monitor: Monitor) {
    if (monitor.status !== "running") {
      props.notify?.(`“${monitor.description}” already finished`, "info")
      return
    }
    if (confirmKill() !== monitor.id) {
      setConfirmKill(monitor.id)
      if (confirmTimer) clearTimeout(confirmTimer)
      confirmTimer = setTimeout(() => setConfirmKill(undefined), KILL_CONFIRM_MS)
      return
    }
    setConfirmKill(undefined)
    try {
      const stopped = await props.source.stop(monitor.id)
      props.notify?.(
        stopped ? `Killed “${monitor.description}”` : `“${monitor.description}” had already finished`,
        stopped ? "success" : "info",
      )
    } catch (err) {
      props.notify?.(`Couldn't kill “${monitor.description}”: ${describeError(err)}`, "error")
    }
    void refresh()
  }

  // Rows available for log lines in each view: the dialog's own chrome takes
  // the rest of the terminal.
  const listRows = createMemo(() => Math.min(Math.max(1, monitors().length), MAX_LIST_ROWS))
  const logRows = createMemo(() => {
    const reserved = expanded() ? 16 : 20 + listRows()
    return Math.max(3, dimensions().height - reserved)
  })
  const visibleLogs = createMemo(() => logWindow(logs(), logRows(), scrollBack()))
  const listOffset = createMemo(() => {
    const rows = MAX_LIST_ROWS
    return Math.max(0, Math.min(index() - rows + 1, monitors().length - rows, index()))
  })

  useKeyboard((key) => {
    const monitor = selected()
    const page = Math.max(1, logRows() - 1)
    switch (key.name) {
      case "up":
        if (expanded()) setScrollBack(visibleLogs().scrollBack + 1)
        else select(index() - 1)
        return
      case "down":
        if (expanded()) setScrollBack(Math.max(0, visibleLogs().scrollBack - 1))
        else select(index() + 1)
        return
      case "pageup":
        setScrollBack(visibleLogs().scrollBack + page)
        return
      case "pagedown":
        setScrollBack(Math.max(0, visibleLogs().scrollBack - page))
        return
      case "home":
        setScrollBack(visibleLogs().maxBack)
        return
      case "end":
        setScrollBack(0)
        return
      case "return":
        if (monitor) {
          setExpanded(!expanded())
          setScrollBack(0)
        }
        return
      case "k":
        if (monitor && !key.ctrl && !key.meta) void kill(monitor)
        return
    }
  })

  const toneColor = (tone: Tone) => {
    const palette = colors()
    return {
      running: palette.running,
      success: palette.success,
      error: palette.error,
      warning: palette.warning,
      muted: palette.muted,
    }[tone]
  }

  const hints = createMemo(() => {
    const dot = props.mono ? " - " : " · "
    const arrows = props.mono ? "up/down" : "↑↓"
    if (expanded()) return [`${arrows} scroll`, "pgup/pgdn page", "end follow", "enter back", "esc close"].join(dot)
    if (monitors().length === 0) return "esc close"
    const canKill = selected()?.status === "running"
    return [`${arrows} select`, "enter full logs", canKill ? "k kill" : undefined, "esc close"]
      .filter(Boolean)
      .join(dot)
  })

  return (
    <box flexDirection="column" width="100%" paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexDirection="row" height={1} flexShrink={0}>
        <text fg={colors().text} attributes={TextAttributes.BOLD} flexShrink={0}>
          Monitors
        </text>
        <box flexGrow={1} />
        <text fg={colors().muted} flexShrink={0}>
          {summary(monitors())}
        </text>
      </box>
      <box height={1} flexShrink={0} />

      <Show when={error()}>
        <text fg={colors().error} wrapMode="word">
          {`Can't reach the Sentinel server plugin: ${error()}. Check that opencode-sentinel is in the plugins list of opencode.json.`}
        </text>
      </Show>

      <Show when={!error() && loaded() && monitors().length === 0}>
        <text fg={colors().muted} wrapMode="word">
          No monitors yet. Ask the agent to watch something, for example “tail server.log and tell me when a 5xx shows up”.
        </text>
      </Show>

      <Show when={!error() && monitors().length > 0 && !expanded()}>
        <box flexDirection="column" flexShrink={0} height={listRows()}>
          <For each={monitors().slice(listOffset(), listOffset() + MAX_LIST_ROWS)}>
            {(monitor, row) => {
              const isSelected = () => row() + listOffset() === index()
              const label = () => statusLabel(monitor, props.mono)
              return (
                <box
                  flexDirection="row"
                  height={1}
                  flexShrink={0}
                  gap={1}
                  backgroundColor={isSelected() ? colors().selectedBg : undefined}
                >
                  <text fg={colors().running} flexShrink={0} width={1}>
                    {isSelected() ? (props.mono ? ">" : "▌") : " "}
                  </text>
                  <text fg={toneColor(label().tone)} flexShrink={0} width={1}>
                    {label().icon}
                  </text>
                  <text
                    fg={colors().text}
                    attributes={isSelected() ? TextAttributes.BOLD : undefined}
                    flexGrow={1}
                    flexShrink={1}
                    minWidth={12}
                    wrapMode="none"
                    truncate
                  >
                    {monitor.description}
                  </text>
                  <text fg={toneColor(label().tone)} width={21} flexShrink={0} wrapMode="none" truncate>
                    {label().text}
                  </text>
                  <text fg={isSelected() ? colors().text : colors().muted} width={11} flexShrink={0} wrapMode="none">
                    {(clockTick(), timing(monitor, now()))}
                  </text>
                  <text fg={isSelected() ? colors().text : colors().muted} width={12} flexShrink={0} wrapMode="none">
                    {formatCount(monitor.linesEmitted, "line")}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
        <box height={1} flexShrink={0} />
      </Show>

      <Show when={!error() && selected()}>
        {(monitor) => (
          <box flexDirection="column" flexShrink={0}>
            <box flexDirection="row" height={1} flexShrink={0} gap={1}>
              <text fg={toneColor(statusLabel(monitor(), props.mono).tone)} flexShrink={0}>
                {statusLabel(monitor(), props.mono).icon}
              </text>
              <text fg={colors().text} attributes={TextAttributes.BOLD} flexShrink={1} wrapMode="none" truncate>
                {monitor().description}
              </text>
              <text fg={colors().muted} flexShrink={0} wrapMode="none">
                {`${props.mono ? "-" : "·"} ${statusLabel(monitor(), props.mono).text} · ${(clockTick(), timing(monitor(), now()))}`}
              </text>
            </box>
            <text fg={colors().faint} height={1} wrapMode="none" truncate>
              {`$ ${monitor().command}`}
            </text>
            <text fg={colors().faint} height={1} wrapMode="none" truncate>
              {[
                `started ${clock(monitor().startedAt)}`,
                monitor().pid ? `pid ${monitor().pid}` : undefined,
                monitor().filter ? `filter ${monitor().filter}` : undefined,
                monitor().until ? `until ${monitor().until}` : undefined,
                formatCount(monitor().linesEmitted, "line"),
              ]
                .filter(Boolean)
                .join(props.mono ? " - " : " · ")}
            </text>
            <box
              height={1}
              flexShrink={0}
              border={["bottom"]}
              borderColor={colors().border}
            />
            <box flexDirection="column" height={logRows()} flexShrink={0}>
              <Show
                when={logs().length > 0}
                fallback={
                  <text fg={colors().muted}>No output yet.</text>
                }
              >
                <For each={visibleLogs().lines}>
                  {(line) => (
                    <box flexDirection="row" height={1} flexShrink={0} gap={1}>
                      <text fg={colors().faint} flexShrink={0} width={8}>
                        {clock(line.at)}
                      </text>
                      <text
                        fg={line.stream === "stderr" ? colors().error : colors().text}
                        flexGrow={1}
                        flexShrink={1}
                        wrapMode="none"
                        truncate
                      >
                        {line.text}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
            <Show when={visibleLogs().scrollBack > 0}>
              <text fg={colors().muted} height={1}>
                {`${props.mono ? "v" : "↓"} ${formatCount(visibleLogs().scrollBack, "newer line")} below · end to follow`}
              </text>
            </Show>
          </box>
        )}
      </Show>

      <box height={1} flexShrink={0} />
      <Show
        when={confirmKill() && selected()?.id === confirmKill()}
        fallback={
          <text fg={colors().muted} height={1} wrapMode="none" truncate>
            {hints()}
          </text>
        }
      >
        <text fg={colors().warning} height={1} wrapMode="none" truncate>
          {`Press k again to kill “${selected()?.description}”`}
        </text>
      </Show>
    </box>
  )
}
