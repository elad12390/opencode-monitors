// What the agent reads about each tool, shared by the V1 and V2 plugins so
// both always say the same thing. Each description is one short paragraph
// that says what the tool does, why to use it, when (and when not), and how.

export const MONITOR = {
  name: "monitor",
  description:
    "Runs a shell command in the background and sends each new line it prints to this session as a message, so you can react the moment something happens instead of polling or sleeping. " +
    "Use it to wait on ongoing output such as a log (tail -f app.log), a CI or PR status (gh run watch <id>) or a dev server crash; for a command whose only result is finishing, use a background shell job instead. " +
    "Give the command and a short description, narrow the lines with filter, stop on a matching line with until, and pipe grep with --line-buffered or lines arrive late. " +
    "Lines arrive grouped every 200 ms, the monitor stops itself above 100 lines per second, and you are told when it ends (exit, kill or OpenCode restart) and whether to start it again, with its last stderr lines if it failed. " +
    "Stop it with stop_monitor once you have what you need; the user can see and kill it in /monitors.",
  params: {
    command: "The shell command to watch, e.g. tail -f server.log | grep --line-buffered ERROR",
    description: "A short name for what you are watching, e.g. API errors. It appears in every message and in /monitors",
    filter: "Only send lines that match this pattern (a JavaScript regex), e.g. ERROR|FATAL. Other lines still show in /monitors",
    until: "Stop the monitor after sending the first line that matches this pattern (a JavaScript regex), e.g. completed|failed",
  },
} as const

export const STOP_MONITOR = {
  name: "stop_monitor",
  description:
    "Stops a running monitor and kills its command, so its output stops waking this session. " +
    "Use it once you have what you were waiting for or the output no longer matters; a monitor whose until matched or whose command ended has already stopped. " +
    "Name the monitor by its description or its ID, and check list_monitors if you are not sure which one is running.",
  params: {
    monitor: "Which monitor to stop: its description, e.g. API errors, or its ID, e.g. mon_mvp6getr_fyl4",
  },
} as const

export const LIST_MONITORS = {
  name: "list_monitors",
  description:
    "Lists the monitors running now, with each one's ID, description, command, running time and lines printed. " +
    "Use it before starting a monitor that may already be running, or to find the one to stop when you have lost track; you don't need it to learn that a monitor ended, since you are told. " +
    "Takes no input.",
} as const
