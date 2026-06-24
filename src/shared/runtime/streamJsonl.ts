import { createReadStream } from 'fs'
import { createInterface } from 'readline'

// Stream a JSONL file as an async iterable of parsed objects, holding
// at most one line in memory at a time.
//
// WHY this exists: the obvious `readFile(path, 'utf8').then(t =>
// t.split('\n').map(JSON.parse))` pattern is the dominant source of
// transient memory spikes in this app's main process. For a 50 MB
// transcript that pattern transiently keeps four representations live:
// a 50 MB Buffer, a 50 MB JS string, a 50 MB-ish array of substrings,
// and the array of parsed JS objects. Total transient peak ~150-200
// MB per call. Replaced with this helper, the peak per call is
// O(longest_line), which for our JSONL transcripts is typically
// <100 KB even for large tool_use entries.
//
// WHY a yielded `null` for malformed lines instead of `throw`: the
// historical behaviour in transcriptParser was `try { JSON.parse } catch
// { continue }` — malformed lines are skipped silently because partial
// writes happen mid-append and recovering from them is normal. Callers
// here filter out nulls themselves, which keeps the parse error visible
// at the call site (matches the existing pattern instead of hiding it
// inside this helper).
//
// WHY no transform/yield-shape variant: YAGNI. If a future caller wants
// to map-while-streaming they can `for await (const line of streamJsonl)
// yield mapped(line)` in their own async generator.
//
// NOT a tailer: this helper opens the file at a snapshot of its current
// size and yields once. Live-growing provider transcripts are tailed by the
// package-owned JsonlTailer implementations in `packages/*-headless`; the old
// shared runtime tailer was a superseded ancestor and was deliberately removed
// so this folder does not look like it owns provider lifecycle watching.
export async function* streamJsonl<T = unknown>(
  path: string,
): AsyncIterable<T | null> {
  const stream = createReadStream(path, { encoding: 'utf8' })
  // crlfDelay: Infinity makes readline treat \r\n as a single line
  // terminator (Windows-authored files are uncommon for our transcripts
  // but the flag is the documented best-practice default).
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        yield JSON.parse(line) as T
      } catch {
        // Malformed JSONL line — partial appends, truncated lines, or
        // pre-existing junk in archived transcripts. Yield null so the
        // caller can either skip-and-continue (current behaviour) or
        // count parse errors for diagnostics if they want to.
        yield null
      }
    }
  } finally {
    // Ensure the underlying file descriptor closes even if the caller
    // breaks out of the loop early. readline closes its own internal
    // state when iteration ends; we still close the stream explicitly
    // because the readline contract doesn't guarantee FD closure on
    // async-iterator break.
    rl.close()
    stream.close()
  }
}
