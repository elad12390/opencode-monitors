/** Longest line passed on to the agent. Anything longer is cut off and marked. */
export const MAX_LINE_CHARS = 64 * 1024

function cut(line: string, max: number): string {
  return `${line.slice(0, max)} … [line cut at ${max} characters]`
}

/**
 * Turns a stream of output chunks into complete lines while holding at most
 * `max` characters of an unfinished line. A line that grows past the limit is
 * emitted once, cut, and the rest of it is skipped up to its newline.
 */
export function createLineSplitter(max = MAX_LINE_CHARS) {
  let buffer = ""
  let skipping = false

  return (chunk: string): string[] => {
    let text = chunk
    if (skipping) {
      const newline = text.indexOf("\n")
      if (newline === -1) return []
      skipping = false
      text = text.slice(newline + 1)
    }

    buffer += text
    const parts = buffer.split("\n")
    buffer = parts.pop() ?? ""
    const lines = parts.map((line) => (line.length > max ? cut(line, max) : line))

    if (buffer.length > max) {
      lines.push(cut(buffer, max))
      buffer = ""
      skipping = true
    }
    return lines
  }
}
