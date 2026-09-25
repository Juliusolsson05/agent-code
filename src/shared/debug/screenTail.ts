// Screen-tail history for debug bundles: a bounded, deduplicated sample of
// the last SCREEN_TAIL_LINES of each session's terminal screen over time.
//
// WHY this lives in shared code and is recorded in MAIN (#762): it used to be
// recorded in the renderer from every `session:screen` frame. That IPC was
// 93% of recorded IPC bytes and is now only forwarded to a renderer that
// asked for it (see src/main/sessions/screenInterest.ts), so the renderer no
// longer sees every frame. Main does, in the forwarder sink, so the history
// is recorded there and handed to the debug bundle on request. The format is
// unchanged: bundles still carry trace/screen/tail-samples.jsonl.

export const SCREEN_TAIL_LINES = 50
export const SCREEN_MAX_SAMPLES = 300

export type ScreenTailSample = {
  id: string
  seq: number
  ts: number
  tsIso: string
  hash: string
  lineCount: number
  content: string
}

/** A fast, non-cryptographic 53-bit string hash (cyrb53), hex. Used to
 *  deduplicate identical samples and to label trace content. */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef ^ text.length
  let h2 = 0x41c6ce57 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return n.toString(16).padStart(13, '0')
}

export function sanitizeScreenText(text: string): string {
  return text
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n\t]+$/gm, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .trimEnd()
}

export function tailLines(text: string, count: number): string {
  const lines = text.split('\n')
  return lines.length <= count ? text : lines.slice(lines.length - count).join('\n')
}

type SessionTail = { samples: ScreenTailSample[]; nextSeq: number; lastHash: string | null }

export class ScreenTailHistory {
  private readonly sessions = new Map<string, SessionTail>()

  constructor(private readonly now: () => number = Date.now) {}

  record(sessionId: string, screenText: string): void {
    const content = tailLines(sanitizeScreenText(screenText), SCREEN_TAIL_LINES)
    if (!content) return
    const hash = hashText(content)
    let tail = this.sessions.get(sessionId)
    if (!tail) {
      tail = { samples: [], nextSeq: 0, lastHash: null }
      this.sessions.set(sessionId, tail)
    }
    if (hash === tail.lastHash) return
    const ts = this.now()
    const seq = tail.nextSeq++
    tail.samples.push({
      id: `${seq.toString(36)}-${hash}`,
      seq,
      ts,
      tsIso: new Date(ts).toISOString(),
      hash,
      lineCount: content.split('\n').length,
      content,
    })
    tail.lastHash = hash
    if (tail.samples.length > SCREEN_MAX_SAMPLES) {
      tail.samples.splice(0, tail.samples.length - SCREEN_MAX_SAMPLES)
    }
  }

  samples(sessionId: string): ScreenTailSample[] {
    return [...(this.sessions.get(sessionId)?.samples ?? [])]
  }

  /** Per-session arrays are bounded, but a map of closed sessions is not. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}
