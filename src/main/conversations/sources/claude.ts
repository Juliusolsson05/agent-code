import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { ConversationPrompt } from '@shared/conversations/types.js'
import { asRecord, parseJsonRecord } from '@shared/lib/asRecord.js'
import { sanitizePath } from '@shared/runtime/projectDir.js'
import { streamJsonl } from '@shared/runtime/streamJsonl.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { extractPromptsFromFile } from '@main/conversations/prompts/promptFolder.js'
import type { ClaudeHistoryIndex } from './claudeHistory.js'
import type { ConversationSource, SourceConversation, SourceScope, PromptReadOptions } from './types.js'

// Claude Code stores one directory per cwd under ~/.claude/projects, named by
// sanitizePath(cwd), and one `<uuid>.jsonl` per session inside it. There is
// no cross-directory index, so discovery is: pick the directories the family
// can own, stat every transcript, then read a bounded head and tail of each.
//
// WHY the head read is RECORD-bounded and not byte-bounded: modern transcripts
// open with `last-prompt`, `mode`, `permission-mode`, `bridge-session` and
// several multi-kilobyte `attachment` records (hook output, environment
// snapshot, deferred tool list) before the first `user` record, which sits at
// index 6–8 on the recorded corpus. A 16 KB byte head, the old lister's
// assumption, can end inside those attachments. JSONL frames by line; so do
// we, and we stop at the first six user texts or 200 records, whichever
// comes first.
//
// WHY the tail read is BYTE-bounded: `ai-title`, `customTitle` and the newest
// user timestamp are re-appended near the end of the file, so the last 64 KB
// holds them; the first complete line inside the window is where parsing
// starts.

const HEAD_RECORD_LIMIT = 200
// WHY four: the classifier needs the first real prompt and skips injected
// messages before it (a slash-command echo, a caveat, a system reminder); the
// corpus never needed more than three skips, and every extra text is another
// block's worth of tool output to parse for a hundred and sixty transcripts.
const HEAD_USER_TEXTS = 4
// One positioned read covers the head of almost every transcript (the first
// user record sits at index 6–8, a few KB in). Streaming line by line costs
// ~11 ms per file on the recorded corpus; a block read costs under 1 ms, and
// the stream only runs for the rare transcript whose head is larger.
const HEAD_BLOCK_BYTES = 64 * 1024
// WHY a second, larger block instead of streaming the file: the first block
// rarely holds six user texts (tool results pad the head), so nearly every
// transcript reached the stream, which parsed up to two hundred records of
// any size. On the author's store that was most of a 1.5 s cold discovery.
// A byte bound keeps the cost proportional to the corpus, and a transcript
// whose first prompts sit beyond a quarter megabyte is labelled by its cwd.
const HEAD_MAX_BYTES = 256 * 1024
// Transcripts are summarised a few at a time: each costs two file opens and
// two parses, and doing 163 of them one after another serialises the disk.
const SUMMARY_CONCURRENCY = 8
const TAIL_BYTES = 64 * 1024
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type ClaudeSummary = {
  cwd: string | null
  gitBranch: string | null
  createdAt: number | null
  userTexts: string[]
  aiTitle: string | null
  customTitle: string | null
  tailUserAt: number | null
  empty: boolean
}

type SummaryCacheEntry = { mtimeMs: number; size: number; summary: ClaudeSummary }

function userText(record: Record<string, unknown>): string | null {
  if (record.type !== 'user') return null
  if (record.isMeta === true) return null
  // WHY compact summaries are NOT skipped here: agent-transcript-parser
  // writes a provider-switch handoff as a `isCompactSummary` user record
  // (`# Handoff Summary…`), and that record is the only evidence a transcript
  // is a projected continuation. Claude's own compaction summaries are user
  // records too; the catalog's unwrapper rejects those by their fixed opening
  // line, so neither becomes a label.
  const message = asRecord(record.message)
  if (!message || message.role !== 'user') return null
  const content = message.content
  if (typeof content === 'string') return content.trim() || null
  if (!Array.isArray(content)) return null
  for (const block of content) {
    const b = asRecord(block)
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) return b.text.trim()
  }
  return null
}

function timestampOf(record: Record<string, unknown>): number | null {
  const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
  return Number.isFinite(ts) ? ts : null
}

type HeadSummary = Pick<ClaudeSummary, 'cwd' | 'gitBranch' | 'createdAt' | 'userTexts'>

function foldHeadRecord(out: HeadSummary, record: Record<string, unknown>): void {
  if (out.cwd === null && typeof record.cwd === 'string' && record.cwd) out.cwd = record.cwd
  if (out.gitBranch === null && typeof record.gitBranch === 'string' && record.gitBranch) out.gitBranch = record.gitBranch
  if (out.createdAt === null) out.createdAt = timestampOf(record)
  const text = userText(record)
  if (text) out.userTexts.push(text)
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}

async function readHead(file: string, size: number): Promise<HeadSummary> {
  const out: HeadSummary = { cwd: null, gitBranch: null, createdAt: null, userTexts: [] }
  const handle = await open(file, 'r')
  try {
    // Complete lines only: a record cut by the block boundary is folded on the
    // next, larger pass, which starts again from byte zero so the fold sees
    // every record once in order.
    for (const blockBytes of [HEAD_BLOCK_BYTES, HEAD_MAX_BYTES]) {
      const len = Math.min(blockBytes, size)
      const buf = Buffer.allocUnsafe(len)
      let offset = 0
      while (offset < len) {
        const { bytesRead } = await handle.read(buf, offset, len - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      const coveredWholeFile = offset >= size
      const lastNewline = buf.lastIndexOf(0x0a, offset - 1)
      const text = (coveredWholeFile ? buf.subarray(0, offset) : buf.subarray(0, Math.max(0, lastNewline + 1))).toString('utf8')
      const pass: HeadSummary = { cwd: null, gitBranch: null, createdAt: null, userTexts: [] }
      let records = 0
      let done = false
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        const record = parseJsonRecord(line)
        if (!record) continue
        records++
        foldHeadRecord(pass, record)
        if (pass.userTexts.length >= HEAD_USER_TEXTS || records >= HEAD_RECORD_LIMIT) {
          done = true
          break
        }
      }
      Object.assign(out, pass)
      if (done || coveredWholeFile || blockBytes === HEAD_MAX_BYTES) return out
    }
    return out
  } finally {
    await handle.close()
  }
}

async function readTail(file: string, size: number): Promise<Pick<ClaudeSummary, 'aiTitle' | 'customTitle' | 'tailUserAt' | 'gitBranch'>> {
  const out = { aiTitle: null as string | null, customTitle: null as string | null, tailUserAt: null as number | null, gitBranch: null as string | null }
  if (size === 0) return out
  const handle = await open(file, 'r')
  try {
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.allocUnsafe(size - start)
    let offset = 0
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, start + offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    let text = buf.subarray(0, offset).toString('utf8')
    if (start > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline < 0 ? '' : text.slice(firstNewline + 1)
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const record = parseJsonRecord(line)
      if (!record) continue
      if (typeof record.aiTitle === 'string' && record.aiTitle.trim()) out.aiTitle = record.aiTitle.trim()
      if (typeof record.customTitle === 'string' && record.customTitle.trim()) out.customTitle = record.customTitle.trim()
      if (typeof record.gitBranch === 'string' && record.gitBranch) out.gitBranch = record.gitBranch
      if (userText(record)) {
        const ts = timestampOf(record)
        if (ts !== null) out.tailUserAt = ts
      }
    }
  } finally {
    await handle.close()
  }
  return out
}

export class ClaudeConversationSource implements ConversationSource {
  readonly provider = 'claude' as const
  private readonly summaries = new Map<string, SummaryCacheEntry>()

  constructor(private readonly deps: { projectsDir: string; history: ClaudeHistoryIndex }) {}

  private async candidateDirs(scope: SourceScope): Promise<Array<{ dir: string; exact: boolean }>> {
    let names: string[]
    try {
      names = (await readdir(this.deps.projectsDir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)
    } catch {
      return []
    }
    if (scope.scope === 'everywhere') return names.map(dir => ({ dir, exact: false }))
    const sanitizedRoots = scope.family.rawRoots.map(sanitizePath)
    const out: Array<{ dir: string; exact: boolean }> = []
    for (const dir of names) {
      const exact = sanitizedRoots.includes(dir)
      // The `-` continuation catches `.worktrees/<name>` (`--worktrees-<name>`),
      // `packages/<x>` and pruned worktrees; a transcript's recorded cwd then
      // decides membership, so `<repo>-other` cannot slip in on the prefix.
      if (exact || (scope.scope === 'repository' && sanitizedRoots.some(r => dir.startsWith(r + '-')))) out.push({ dir, exact })
    }
    return out
  }

  private async summarize(file: string, mtimeMs: number, size: number): Promise<ClaudeSummary> {
    const cached = this.summaries.get(file)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.summary
    const head = await readHead(file, size)
    const tail = await readTail(file, size)
    const summary: ClaudeSummary = {
      cwd: head.cwd,
      gitBranch: tail.gitBranch ?? head.gitBranch,
      createdAt: head.createdAt,
      userTexts: head.userTexts,
      aiTitle: tail.aiTitle,
      customTitle: tail.customTitle,
      tailUserAt: tail.tailUserAt,
      empty: size === 0,
    }
    this.summaries.set(file, { mtimeMs, size, summary })
    return summary
  }

  async discover(scope: SourceScope): Promise<SourceConversation[]> {
    const span = performanceService.span('conversations.claude.discover', { scope: scope.scope })
    await this.deps.history.refresh()
    const dirs = await this.candidateDirs(scope)
    const rows: SourceConversation[] = []
    const seen = new Set<string>()
    // Every candidate file first, deduplicated by id in directory order so a
    // transcript copied into two project dirs is claimed by the first, then
    // summarised through a small pool.
    const candidates: Array<{ file: string; nativeId: string; exact: boolean }> = []
    for (const { dir, exact } of dirs) {
      let names: string[]
      try {
        names = await readdir(join(this.deps.projectsDir, dir))
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const nativeId = name.slice(0, -6)
        if (!UUID_RE.test(nativeId) || seen.has(nativeId)) continue
        seen.add(nativeId)
        candidates.push({ file: join(this.deps.projectsDir, dir, name), nativeId, exact })
      }
    }
    const summarized = await mapWithConcurrency(candidates, SUMMARY_CONCURRENCY, async candidate => {
      try {
        const s = await stat(candidate.file)
        return { ...candidate, mtimeMs: s.mtimeMs, summary: await this.summarize(candidate.file, s.mtimeMs, s.size) }
      } catch {
        return null
      }
    })
    for (const item of summarized) {
      if (!item) continue
      const { file, nativeId, exact, summary, mtimeMs } = item
      // Membership: the recorded cwd wins; a transcript that never recorded
      // one (the 0-byte session) belongs only to an exactly-matching dir.
      if (scope.scope !== 'everywhere') {
        if (summary.cwd ? !scope.family.matches(summary.cwd) : !exact) continue
      }
      const history = this.deps.history.bySession(nativeId)
      const historyLast = history.length > 0 ? history[history.length - 1]!.timestamp : null
      rows.push({
        provider: 'claude',
        nativeId,
        cwd: summary.cwd,
        gitBranch: summary.gitBranch,
        customTitle: summary.customTitle,
        aiTitle: summary.aiTitle,
        userTexts: summary.userTexts,
        createdAt: summary.createdAt,
        lastUserActivityAt: historyLast ?? summary.tailUserAt,
        activitySource: historyLast !== null ? 'history' : summary.tailUserAt !== null ? 'tail' : null,
        mtime: mtimeMs,
        promptCount: history.length > 0 ? history.length : null,
        parentNativeId: null,
        isNativeSubagent: false,
        isExec: false,
        originator: null,
        origin: 'scan',
        available: !summary.empty,
        file,
      })
    }
    span.end({ dirs: dirs.length, rows: rows.length })
    return rows
  }

  async prompts(nativeId: string, cwd: string, options: PromptReadOptions = {}): Promise<ConversationPrompt[]> {
    const direct = join(this.deps.projectsDir, sanitizePath(cwd), `${nativeId}.jsonl`)
    let file: string | null = null
    try {
      await stat(direct)
      file = direct
    } catch {
      // A conversation listed from a worktree dir is asked for with its own
      // cwd, so the direct path is the common case; the walk is the rare one.
      try {
        for (const dir of await readdir(this.deps.projectsDir)) {
          const candidate = join(this.deps.projectsDir, dir, `${nativeId}.jsonl`)
          try {
            await stat(candidate)
            file = candidate
            break
          } catch {
            // keep looking
          }
        }
      } catch {
        file = null
      }
    }
    if (!file) return []
    const { prompts } = await extractPromptsFromFile('claude', nativeId, file, options.need ?? 'all', { maxBytes: options.maxBytes })
    return prompts.map(p => ({ text: p.text, timestamp: p.ts }))
  }
}
