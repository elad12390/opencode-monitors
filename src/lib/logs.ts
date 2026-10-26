export type LogStream = "stdout" | "stderr"

export interface LogLine {
  at: string
  stream: LogStream
  text: string
}

/** Most lines kept per monitor. */
export const MAX_LOG_LINES = 1_000
/** Most characters kept per monitor across all its lines. */
export const MAX_LOG_CHARS = 1_000_000

/** Recent output of one monitor; the oldest lines drop off first. */
export class LogBuffer {
  private lines: LogLine[] = []
  private chars = 0

  constructor(
    private readonly maxLines = MAX_LOG_LINES,
    private readonly maxChars = MAX_LOG_CHARS,
  ) {}

  append(stream: LogStream, text: string, at = new Date().toISOString()): void {
    this.lines.push({ at, stream, text })
    this.chars += text.length
    while (
      this.lines.length > this.maxLines ||
      (this.chars > this.maxChars && this.lines.length > 1)
    ) {
      this.chars -= this.lines.shift()!.text.length
    }
  }

  /** The last `limit` lines, oldest first. */
  tail(limit = this.maxLines): LogLine[] {
    return this.lines.slice(-limit)
  }

  get size(): number {
    return this.lines.length
  }
}
