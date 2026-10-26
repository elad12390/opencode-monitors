import { Rpc } from "@opencode/plugin/rpc"

const MONITOR = {
  type: "object",
  properties: {
    id: { type: "string" },
    description: { type: "string" },
    command: { type: "string" },
    startedAt: { type: "string" },
    endedAt: { type: "string" },
    linesEmitted: { type: "number" },
    sessionID: { type: "string" },
    status: {
      type: "string",
      enum: ["running", "completed", "failed", "stopped", "until", "flood", "slow-filter", "filter-error"],
    },
    exitCode: { type: ["number", "null"] },
    signal: { type: ["string", "null"] },
    pid: { type: "number" },
    filter: { type: "string" },
    until: { type: "string" },
  },
  required: ["id", "description", "command", "startedAt", "linesEmitted", "sessionID", "status"],
} as const

const LOG_LINE = {
  type: "object",
  properties: {
    at: { type: "string" },
    stream: { type: "string", enum: ["stdout", "stderr"] },
    text: { type: "string" },
  },
  required: ["at", "stream", "text"],
} as const

const MONITOR_ID = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
  additionalProperties: false,
} as const

const NOT_FOUND = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
} as const

/** Lets the /monitors view read monitors and their logs from the server, and stop them. */
export const SentinelRpc = Rpc.define({
  id: "sentinel",
  methods: {
    list: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: {
        type: "object",
        properties: { monitors: { type: "array", items: MONITOR } },
        required: ["monitors"],
      },
    },
    logs: {
      input: {
        type: "object",
        properties: { id: { type: "string" }, limit: { type: "number" } },
        required: ["id"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { lines: { type: "array", items: LOG_LINE } },
        required: ["lines"],
      },
      errors: { not_found: NOT_FOUND },
    },
    stop: {
      input: MONITOR_ID,
      output: {
        type: "object",
        properties: { stopped: { type: "boolean" } },
        required: ["stopped"],
      },
      errors: { not_found: NOT_FOUND },
    },
  },
  events: {
    changed: { schema: MONITOR_ID },
  },
})
