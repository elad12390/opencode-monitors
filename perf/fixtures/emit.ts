// Line generator for the performance suite. Each line carries its sequence
// number and the wall-clock time it was written, so the receiving side can
// measure end-to-end latency:  L <seq> <epochMs>
//
//   --count N     lines to write (default 10)
//   --rate R      lines per second; 0 writes them as fast as possible (default 10)
//   --pad B       extra bytes appended to each line (default 0)
//   --blob B      instead of lines, write B bytes with no newline
//   --hold MS     stay alive this long after writing (default 0)

const args = new Map<string, number>()
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), Number(process.argv[i + 1]))
}
const count = args.get("count") ?? 10
const rate = args.get("rate") ?? 10
const pad = "x".repeat(args.get("pad") ?? 0)
const blob = args.get("blob") ?? 0
const hold = args.get("hold") ?? 0

const now = () => performance.timeOrigin + performance.now()

if (blob > 0) {
  const chunk = "y".repeat(64 * 1024)
  let written = 0
  while (written < blob) {
    const size = Math.min(chunk.length, blob - written)
    await Bun.write(Bun.stdout, chunk.slice(0, size))
    written += size
  }
} else {
  const interval = rate > 0 ? 1000 / rate : 0
  const start = now()
  for (let seq = 0; seq < count; seq++) {
    if (interval > 0) {
      const due = start + seq * interval
      const wait = due - now()
      if (wait > 0) await Bun.sleep(wait)
    }
    process.stdout.write(`L ${seq} ${now().toFixed(3)}${pad ? " " + pad : ""}\n`)
  }
}

if (hold > 0) await Bun.sleep(hold)
