// What the agent reads about each tool, shared by the V1 and V2 plugins so
// both always say the same thing. Each description covers what the tool does,
// why to use it, when (and when not), and how, in that order.

export const MONITOR = {
  name: "monitor",
  description: [
    "What: runs a shell command in the background and sends each new line it prints to this session as a message.",
    "Why: so you react the moment something happens, instead of polling or holding the turn with sleep.",
    "When: waiting on ongoing output, such as a log line (tail -f app.log), a CI or PR status change (gh run watch <id>) or a dev server crash. Not for a command whose only result is finishing; run that as a background shell job.",
    "How: give the command and a short description. Narrow the lines with filter, stop on a matching line with until, and pipe grep with --line-buffered or lines arrive late. Lines come grouped every 200 ms. You are told when the monitor ends (exit, kill, OpenCode restart) and whether to start it again. It stops itself above 100 lines per second. Stop it with stop_monitor once you have what you need; the user sees it in /monitors.",
  ].join("\n"),
  params: {
    command: "The shell command to watch, e.g. tail -f server.log | grep --line-buffered ERROR",
    description: "A short name for what you are watching, e.g. API errors. It appears in every message and in /monitors",
    filter: "Only send lines that match this pattern (a JavaScript regex), e.g. ERROR|FATAL. Other lines still show in /monitors",
    until: "Stop the monitor after sending the first line that matches this pattern (a JavaScript regex), e.g. completed|failed",
  },
} as const

export const STOP_MONITOR = {
  name: "stop_monitor",
  description: [
    "What: stops a running monitor and kills its command.",
    "Why: a monitor runs until stopped, and every line it prints wakes this session.",
    "When: you have what you were waiting for, or its output no longer matters. Not needed after until matched or the command ended; those stop by themselves.",
    "How: name the monitor by its description or its ID. Use list_monitors if you are not sure which is running.",
  ].join("\n"),
  params: {
    monitor: "Which monitor to stop: its description, e.g. API errors, or its ID, e.g. mon_mvp6getr_fyl4",
  },
} as const

export const LIST_MONITORS = {
  name: "list_monitors",
  description: [
    "What: lists the monitors running now, with each one's ID, description, command, how long it has run and how many lines it printed.",
    "Why: to check what is already being watched, and to find the monitor to stop.",
    "When: before starting a monitor that may already be running, or when you have lost track of one. Not needed to learn that a monitor ended; you are told.",
    "How: takes no input.",
  ].join("\n"),
} as const
