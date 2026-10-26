// Runs a monitor's filter/until regexes off the main thread, so a pattern that
// backtracks for seconds blocks only this worker, never the OpenCode server.

const worker = self as unknown as Worker

interface Init {
  type: "init"
  filter?: string
  until?: string
}

interface Test {
  type: "test"
  id: number
  line: string
}

let filter: RegExp | null = null
let until: RegExp | null = null

worker.onmessage = (event: MessageEvent<Init | Test>) => {
  const message = event.data
  if (message.type === "init") {
    filter = message.filter ? new RegExp(message.filter) : null
    until = message.until ? new RegExp(message.until) : null
    return
  }
  const keep = !filter || filter.test(message.line)
  const stop = keep && !!until && until.test(message.line)
  worker.postMessage({ id: message.id, keep, stop })
}
