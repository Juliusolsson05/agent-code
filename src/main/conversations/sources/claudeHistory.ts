import { open, stat } from 'node:fs/promises'

import { parseJsonRecord } from '@shared/lib/asRecord.js'

// ~/.claude/history.jsonl: one record per prompt the user typed into any
// Claude Code session, `{ display, pastedContents, timestamp, project,
// sessionId }`. Claude Code appends it on every submit.
//
// WHY this is the Claude prompt index rather than the transcripts: on the
// author's machine it holds 13,174 prompts for 1,566 sessions in 4.6 MB, a
// substring search over all of it takes 34 ms, and it covers 56 of the 57
// transcripts in the focused project. The transcripts are 283 MB for the same
// project. The 30 transcripts with no history record are projected or
// SDK-smoke sessions, which the head read labels anyway.
//
// WHY incremental by byte offset: the file is append-only by construction.
// Re-reading 4.6 MB per keystroke is the class of cost #735 removed from the
// old index; folding only the appended bytes keeps a refresh at O(new
// prompts). A shrink means a rewrite (Claude Code compacts history on some
// upgrades) and rebuilds from zero.

export type HistoryPrompt = {
  text: string
  timestamp: number
  project: string
  sessionId: string
}

const NEWLINE = 0x0a

export class ClaudeHistoryIndex {
  private readonly bySessionId = new Map<string, HistoryPrompt[]>()
  private parsedTo = 0
  private lastBytesRead = 0

  constructor(private readonly file: string) {}

  async refresh(): Promise<void> {
    let size: number
    try {
      size = (await stat(this.file)).size
    } catch {
      this.bySessionId.clear()
      this.parsedTo = 0
      this.lastBytesRead = 0
      return
    }
    if (size < this.parsedTo) {
      this.bySessionId.clear()
      this.parsedTo = 0
    }
    if (size === this.parsedTo) {
      this.lastBytesRead = 0
      return
    }
    const handle = await open(this.file, 'r')
    try {
      const buf = Buffer.allocUnsafe(size - this.parsedTo)
      let offset = 0
      while (offset < buf.length) {
        const { bytesRead } = await handle.read(buf, offset, buf.length - offset, this.parsedTo + offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      this.lastBytesRead = offset
      // Only complete lines fold; a trailing partial line (Claude Code mid-append)
      // stays outside the parsed range until its newline lands.
      const lastNewline = buf.lastIndexOf(NEWLINE, offset - 1)
      if (lastNewline < 0) return
      const text = buf.subarray(0, lastNewline + 1).toString('utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        const record = parseJsonRecord(line)
        if (!record) continue
        const sessionId = typeof record.sessionId === 'string' ? record.sessionId : null
        const display = typeof record.display === 'string' ? record.display : null
        const timestamp = typeof record.timestamp === 'number' ? record.timestamp : null
        const project = typeof record.project === 'string' ? record.project : ''
        if (!sessionId || display === null || timestamp === null) continue
        let list = this.bySessionId.get(sessionId)
        if (!list) {
          list = []
          this.bySessionId.set(sessionId, list)
        }
        list.push({ text: display, timestamp, project, sessionId })
      }
      this.parsedTo += lastNewline + 1
    } finally {
      await handle.close()
    }
  }

  /** Chronological (the file is chronological; nothing re-sorts). */
  bySession(sessionId: string): readonly HistoryPrompt[] {
    return this.bySessionId.get(sessionId) ?? []
  }

  sessionIds(): Iterable<string> {
    return this.bySessionId.keys()
  }

  bytesReadForTests(): number {
    return this.lastBytesRead
  }
}
