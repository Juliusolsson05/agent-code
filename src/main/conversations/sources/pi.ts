import { open, stat } from 'node:fs/promises'
import { basename } from 'node:path'

import { listAllPiSessionFiles, readPiBranch, resolvePiSessionFile, sessionIdFromFileName } from 'pi-terminal-headless'

import type { ConversationPrompt } from '@shared/conversations/types.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import type { ConversationSource, SourceConversation, SourceScope } from './types.js'

// Pi conversation discovery, straight from Pi's session files — the same
// files pi's own /resume picker lists. There is no separate index: each
// session is one `<ts>_<id>.jsonl`, under one directory per cwd by default or
// in a flat custom session dir (pi-terminal-headless listAllPiSessionFiles).
//
// WHY every file's HEADER is read, not its directory name: the per-cwd
// directory name is a lossy encoding of the cwd (`/` and `-` both become
// `-`), so only the header's `cwd` says which project a session belongs to —
// and scoping must use the shared family matcher on it, like every source.
//
// WHY a bounded head read for the listing: the catalog lists every session on
// every open, and Pi files hold whole conversations. The first HEAD_BYTES hold
// the header (always line 0), the first prompts (Pi writes the system prompt
// and then the first user message right after the header) and usually an
// early `/name`. The prompt LIST (search, View Prompts) reads the full active
// branch, because only the whole tree says which prompts are still on it.

const HEAD_BYTES = 64 * 1024
const MAX_USER_TEXTS = 3

type HeadScan = {
  header: { id: string; cwd: string; timestamp?: string; parentSession?: string } | null
  userTexts: string[]
  name: string | null
  truncated: boolean
}

async function scanHead(file: string): Promise<HeadScan> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    // A read that filled the buffer may end mid-line: drop the partial tail.
    const lines = text.split('\n')
    const complete = bytesRead === HEAD_BYTES ? lines.slice(0, -1) : lines
    const scan: HeadScan = { header: null, userTexts: [], name: null, truncated: bytesRead === HEAD_BYTES }
    for (const line of complete) {
      if (!line.trim()) continue
      let row: Record<string, unknown>
      try {
        row = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (row.type === 'session' && typeof row.id === 'string' && typeof row.cwd === 'string') {
        scan.header = { id: row.id, cwd: row.cwd, ...(typeof row.timestamp === 'string' ? { timestamp: row.timestamp } : {}), ...(typeof row.parentSession === 'string' ? { parentSession: row.parentSession } : {}) }
      } else if (row.type === 'session_info' && typeof row.name === 'string' && row.name.trim()) {
        scan.name = row.name.trim()
      } else if (row.type === 'message' && scan.userTexts.length < MAX_USER_TEXTS) {
        const message = row.message as { role?: unknown; content?: unknown } | undefined
        if (message?.role !== 'user') continue
        const text = typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content.filter(block => (block as { type?: unknown }).type === 'text').map(block => String((block as { text?: unknown }).text ?? '')).join('\n')
            : ''
        if (text.trim()) scan.userTexts.push(text)
      }
    }
    return scan
  } finally {
    await handle.close()
  }
}

export class PiConversationSource implements ConversationSource {
  readonly provider = 'pi' as const

  constructor(private readonly deps: { env?: Record<string, string | undefined>; homeDirectory?: string } = {}) {}

  async discover(scope: SourceScope): Promise<SourceConversation[]> {
    const span = performanceService.span('conversations.pi.discover', { scope: scope.scope })
    const files = await listAllPiSessionFiles({ env: this.deps.env ?? process.env, ...(this.deps.homeDirectory ? { homeDirectory: this.deps.homeDirectory } : {}) })
    const rows: SourceConversation[] = []
    let unreadable = 0
    for (const file of files) {
      let head: HeadScan
      let mtime: number
      try {
        ;[head, mtime] = await Promise.all([scanHead(file), stat(file).then(info => info.mtimeMs)])
      } catch {
        unreadable += 1
        continue
      }
      // Not a Pi session file (no header): not a conversation, not an error.
      if (!head.header) continue
      if (scope.scope !== 'everywhere' && !scope.family.matches(head.header.cwd)) continue
      rows.push(this.toRow(file, head, mtime))
    }
    span.end({ mode: 'scan', rows: rows.length, files: files.length, unreadable })
    return rows
  }

  /** Every user prompt on the session's active branch, newest first. */
  async prompts(nativeId: string, cwd: string): Promise<ConversationPrompt[]> {
    try {
      const file = await resolvePiSessionFile({ env: this.deps.env ?? process.env, cwd, sessionId: nativeId, ...(this.deps.homeDirectory ? { homeDirectory: this.deps.homeDirectory } : {}) })
      if (!file) return []
      const { rows } = await readPiBranch(file)
      const prompts: ConversationPrompt[] = []
      for (const row of rows) {
        const message = row.message as { role?: unknown; content?: unknown; timestamp?: unknown } | undefined
        if (row.type !== 'message' || message?.role !== 'user') continue
        const text = typeof message.content === 'string'
          ? message.content
          : Array.isArray(message.content)
            ? message.content.filter(block => (block as { type?: unknown }).type === 'text').map(block => String((block as { text?: unknown }).text ?? '')).join('\n')
            : ''
        if (text.trim()) prompts.push({ text, timestamp: typeof message.timestamp === 'number' ? message.timestamp : null })
      }
      return prompts.reverse()
    } catch {
      return []
    }
  }

  private toRow(file: string, head: HeadScan, mtime: number): SourceConversation {
    const header = head.header!
    const createdAt = header.timestamp ? Date.parse(header.timestamp) : NaN
    return {
      provider: 'pi',
      nativeId: header.id,
      cwd: header.cwd || null,
      gitBranch: null,
      // `/name` is a name the user chose, like Claude's custom title.
      customTitle: head.name,
      aiTitle: null,
      userTexts: head.userTexts,
      ...(head.truncated && head.userTexts.length === 0 ? { headTruncated: true } : {}),
      createdAt: Number.isFinite(createdAt) ? createdAt : null,
      // Pi appends a row per message, so the file's mtime IS the time of the
      // last activity; there is no separate history index to prefer.
      lastUserActivityAt: mtime,
      activitySource: 'tail',
      mtime,
      promptCount: null,
      // A fork's header names its parent FILE; the parent's id is in its name.
      parentNativeId: header.parentSession ? sessionIdFromFileName(basename(header.parentSession)) ?? null : null,
      isNativeSubagent: false,
      isExec: false,
      originator: null,
      origin: 'scan',
      available: true,
      file,
    }
  }
}
