import { existsSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { ConversationPrompt } from '@shared/conversations/types.js'
import { asRecord } from '@shared/lib/asRecord.js'
import { streamJsonl } from '@shared/runtime/streamJsonl.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { extractPromptsFromFile } from '@main/conversations/prompts/promptFolder.js'
import { findCodexRolloutPathByThreadId } from 'codex-headless'
import { newestCodexStateDb, openReadOnlySqlite } from './sqlite.js'
import { assertTreeListable, ConversationPromptsUnreadable, isMissingFileError, isPresent, type ConversationSource, type SourceConversation, type SourceScope, type PromptReadOptions } from './types.js'

// Codex keeps its own index at ~/.codex/state_N.sqlite (`threads`,
// `thread_spawn_edges`), maintained by the CLI and backfilled from rollouts.
// It is what Codex's own resume picker reads. On the author's machine it
// answered "every thread for this repository" in 50 ms where the rollout
// walk took 1.5–2.9 s, and its `title` is the real first prompt because
// Codex strips its own AGENTS.md injection before writing it. So the index
// is the primary source, always.
//
// Three ways the index and the files disagree, each handled explicitly:
//   1. schema drift — `openReadOnlySqlite` probes the columns below and the
//      adapter downgrades to the scan with a recorded reason;
//   2. index rows whose rollout is gone (9 on the author's machine) — kept,
//      marked unavailable, so the user sees why a resume would fail;
//   3. rollouts the index never saw (22, all pre-index) — found by one
//      cached walk of the sessions tree and parsed by a local head reader.
//
// WHY `has_user_event` is ignored: it is 0 on every row of the recorded
// index and cannot be trusted as a "real session" signal.

export const CODEX_INDEX_COLUMNS = {
  threads: [
    'id', 'rollout_path', 'cwd', 'title', 'first_user_message', 'preview', 'name',
    'source', 'thread_source', 'agent_role', 'git_branch', 'created_at_ms',
    'updated_at_ms', 'recency_at_ms', 'archived', 'originator',
  ],
  thread_spawn_edges: ['parent_thread_id', 'child_thread_id'],
}

const DEFAULT_WALK_TTL_MS = 5 * 60 * 1000
const HEAD_RECORD_LIMIT = 200
const ROLLOUT_RE = /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

type IndexRow = {
  id: string
  rollout_path: string
  cwd: string
  title: string | null
  first_user_message: string | null
  preview: string | null
  name: string | null
  source: string
  thread_source: string | null
  agent_role: string | null
  git_branch: string | null
  created_at_ms: number | null
  updated_at_ms: number | null
  recency_at_ms: number | null
  archived: number
  originator: string | null
}

type RolloutHead = {
  cwd: string | null
  gitBranch: string | null
  createdAt: number | null
  originator: string | null
  source: string | null
  userTexts: string[]
  lastUserAt: number | null
  /** The head hit its record bound with no user text (as for Claude and Pi). */
  headTruncated?: boolean
}

/**
 * One `threads` row, typed by value rather than trusted by column (review of
 * #1411, b). SQLite stores any value in any column whatever its declared type,
 * so a BLOB title made `(row.title ?? '').trim()` throw, and that one row
 * rejected the whole Codex discovery. A field of the wrong type becomes its
 * empty value (a title then falls back to the next label); only a row with no
 * string id is dropped, because nothing can address it.
 */
function normalizeIndexRow(raw: Record<string, unknown>): IndexRow | null {
  const text = (value: unknown): string | null => typeof value === 'string' ? value : null
  const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
  const id = text(raw.id)
  if (!id) return null
  return {
    id,
    rollout_path: text(raw.rollout_path) ?? '',
    cwd: text(raw.cwd) ?? '',
    title: text(raw.title),
    first_user_message: text(raw.first_user_message),
    preview: text(raw.preview),
    name: text(raw.name),
    source: text(raw.source) ?? '',
    thread_source: text(raw.thread_source),
    agent_role: text(raw.agent_role),
    git_branch: text(raw.git_branch),
    created_at_ms: num(raw.created_at_ms),
    updated_at_ms: num(raw.updated_at_ms),
    recency_at_ms: num(raw.recency_at_ms),
    archived: num(raw.archived) ?? 0,
    originator: text(raw.originator),
  }
}

function isSubagentSource(row: IndexRow): boolean {
  if (row.thread_source === 'subagent') return true
  if (row.agent_role) return true
  // `source` is a JSON object for AgentControl spawns:
  // {"subagent":{"thread_spawn":{...}}}. Codex's own lister classifies by
  // deserialising it; a substring test is enough for a boolean and never
  // throws on a future shape.
  return row.source.startsWith('{') && row.source.includes('"subagent"')
}

/** Local head reader for rollouts the index does not cover. Mirrors
 *  codex-headless's parseCodexSession but also keeps the first few user
 *  texts and the newest user timestamp, which the picker needs and that
 *  lister does not return. Duplicated on purpose: widening the package
 *  contract for a fallback path is not worth a cross-repository change. */
async function readRolloutHead(file: string): Promise<RolloutHead> {
  const out: RolloutHead = { cwd: null, gitBranch: null, createdAt: null, originator: null, source: null, userTexts: [], lastUserAt: null }
  // Two carriers of a user prompt (#1363). Codex up to 0.14x wrote
  // `event_msg:user_message`; 0.157 writes none, and a prompt is
  // `event_msg:item_completed` with `item.type: 'UserMessage'` (414 of 416
  // local 0.157 files; the other two are native subagents with no prompt).
  // These are exactly the two carriers Codex's own index reads for
  // `first_user_message` (rust-v0.157.1 state/src/extract.rs); it ignores the
  // role-user response_item, which also carries injected context. WHY both are
  // read and merged, not "legacy wins" (#1407 reviews a and b): a file with
  // both carriers (a session resumed across writer versions) could then lose
  // a prompt only the items hold. The same prompt written by both carriers is
  // counted once: see the pairing rule below (the immediately previous user
  // record, the other carrier, within 4 records and 5 s).
  // What older CLIs put in UserMessage items (sometimes injected context or a
  // command wrapper) is what the index lists too; firstUnwrappedPrompt and
  // classify decide what is a label, as for every other source.
  // WHY a pair is matched only within a few records (#1407 verification a):
  // matching identical text anywhere in the head collapsed a prompt the user
  // really repeated in a later turn. Codex writes the two carriers of ONE
  // prompt back to back, so the other carrier's record must be close.
  // Both a record window AND a time window (#1407 verification a, round 2):
  // records alone let the same text typed two days later, two records on,
  // pass for the other carrier. One prompt's carriers share its instant.
  const PAIR_WINDOW_RECORDS = 4
  const PAIR_WINDOW_MS = 5_000
  let lastUser: { carrier: 'legacy' | 'item'; text: string; at: number; ts: number; paired: boolean } | null = null
  const noteUser = (carrier: 'legacy' | 'item', text: string, timestamp: unknown, recordIndex: number) => {
    const ts = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN
    // ...and never across another user prompt (#1407 verification b): the
    // other carrier must be the IMMEDIATELY previous user record, so
    // `repeat, different, repeat` inside a few seconds keeps both repeats.
    const previous = lastUser
    const pairs = previous !== null && previous.carrier !== carrier && !previous.paired &&
      previous.text === text &&
      recordIndex - previous.at <= PAIR_WINDOW_RECORDS &&
      Number.isFinite(ts) && Number.isFinite(previous.ts) && Math.abs(ts - previous.ts) <= PAIR_WINDOW_MS
    if (pairs) {
      previous.paired = true
    } else {
      lastUser = { carrier, text, at: recordIndex, ts, paired: false }
      if (out.userTexts.length < 6) out.userTexts.push(text)
    }
    if (Number.isFinite(ts)) out.lastUserAt = Math.max(out.lastUserAt ?? ts, ts)
  }
  let records = 0
  let truncated = false
  for await (const record of streamJsonl<Record<string, unknown>>(file)) {
    if (!record) continue
    records++
    const payload = asRecord(record.payload)
    if (record.type === 'session_meta' && payload) {
      out.cwd = typeof payload.cwd === 'string' ? payload.cwd : null
      const git = asRecord(payload.git)
      out.gitBranch = git && typeof git.branch === 'string' ? git.branch : null
      out.createdAt = typeof payload.timestamp === 'string' && Number.isFinite(Date.parse(payload.timestamp)) ? Date.parse(payload.timestamp) : null
      out.originator = typeof payload.originator === 'string' ? payload.originator : null
      out.source = typeof payload.source === 'string' ? payload.source : payload.source ? JSON.stringify(payload.source) : null
    } else {
      const user = userPromptOf(record, payload)
      if (user !== null) noteUser(user.carrier, user.text, record.timestamp, records)
    }
    // WHY the limit is unconditional: a rollout whose first two hundred
    // records hold no user event (exec runs, synthesized transcripts) has
    // nothing further up the file the head can label it by, and reading such
    // files to the end made discovery cost the size of the store.
    if (records >= HEAD_RECORD_LIMIT) {
      truncated = true
      break
    }
  }
  if (truncated) {
    // WHY a tail pass (#1407 reviews a and b): the listing sorts by user
    // activity, and a head-bounded read reported the last prompt within the
    // first 200 records. In 33 of 61 local 0.157.0 files a later prompt lay
    // beyond them (one 46.8 hours later), so a live session sorted days too
    // old. The newest prompt is near the end of the file, so reading a
    // bounded tail finds it at a fixed cost; the head keeps the labels.
    const tailAt = await newestUserTimestampInTail(file)
    if (tailAt !== null) out.lastUserAt = Math.max(out.lastUserAt ?? tailAt, tailAt)
    out.headTruncated = out.userTexts.length === 0
  }
  return out
}

// The newest user timestamp is found by reading the rollout BACKWARD in
// chunks until a user record appears (#1407 verification a). A fixed 512 KiB
// tail missed it in 10 of 46 local 0.157 files whose latest prompt was past
// the head (a long agent turn can write megabytes after one prompt), and it
// dropped a record straddling the window's start. Reading back in chunks,
// carrying the partial line across each boundary, finds the newest one wherever
// it is. The scan is bounded: a file with no user record in its last
// TAIL_ACTIVITY_MAX_BYTES keeps the head's time, which is at worst the old
// behaviour. It runs only for heads that hit their record bound, and the
// result is cached by mtime with the head. WHY a bound at all, knowing it
// misses (1 of 452 local 0.157 files had its newest prompt 55.8 MB from the
// end, #1407 verification a): this is the degraded no-index path, rollouts
// reach gigabytes, and an unbounded scan per discovery is the store-sized
// cost the head limit above exists to prevent.
const TAIL_ACTIVITY_CHUNK_BYTES = 512 * 1024
const TAIL_ACTIVITY_MAX_BYTES = 32 * 1024 * 1024

async function newestUserTimestampInTail(file: string): Promise<number | null> {
  let handle
  try {
    handle = await open(file, 'r')
    const { size } = await handle.stat()
    let end = size
    // Bytes of the line that starts before the current chunk and was cut off.
    let carry = Buffer.alloc(0)
    while (end > 0 && size - end < TAIL_ACTIVITY_MAX_BYTES) {
      const start = Math.max(0, end - TAIL_ACTIVITY_CHUNK_BYTES)
      const chunk = Buffer.alloc(end - start)
      await handle.read(chunk, 0, chunk.length, start)
      const window = Buffer.concat([chunk, carry])
      // Unless this chunk starts the file, its first line is incomplete: keep
      // its bytes for the next (earlier) chunk rather than dropping it. A
      // window with NO newline is all one line longer than a chunk: carry the
      // whole of it (#1407 verification a, round 2), never parse or drop it.
      const firstBreak = window.indexOf(0x0a)
      if (start > 0 && firstBreak < 0) {
        carry = window
        end = start
        continue
      }
      const complete = start > 0 ? window.subarray(firstBreak + 1).toString('utf8') : window.toString('utf8')
      carry = start > 0 ? window.subarray(0, firstBreak) : Buffer.alloc(0)
      const newest = newestUserTimestampIn(complete.split('\n'))
      if (newest !== null) return newest
      if (start === 0) break
      end = start
    }
    return null
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => {})
  }
}

function newestUserTimestampIn(lines: string[]): number | null {
  let newest: number | null = null
  for (const line of lines) {
    if (!line.includes('"user_message"') && !line.includes('"UserMessage"')) continue
    let record: Record<string, unknown>
    try {
      record = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (userPromptOf(record, asRecord(record.payload)) === null) continue
    const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
    if (Number.isFinite(ts)) newest = Math.max(newest ?? ts, ts)
  }
  return newest
}

/** The user prompt a rollout record carries, and through which carrier. */
function userPromptOf(record: Record<string, unknown>, payload: Record<string, unknown> | null): { carrier: 'legacy' | 'item'; text: string } | null {
  if (record.type !== 'event_msg' || !payload) return null
  if (payload.type === 'user_message' && typeof payload.message === 'string') return { carrier: 'legacy', text: payload.message }
  if (payload.type === 'item_completed') {
    const text = userMessageItemText(payload.item)
    if (text !== null) return { carrier: 'item', text }
  }
  return null
}

/** The text of a 0.157 `UserMessage` turn item (`{type, id, content: [{type:
 *  'text', text, text_elements}]}`), or null for any other item. Text parts
 *  are joined with no separator, as Codex's own UserMessageItem::message()
 *  does (protocol/src/items.rs). A message of only images reads `[Image]`,
 *  Codex's own preview text (protocol.rs user_message_preview), so an
 *  image-only prompt is still a prompt (#1407 review b). */
function userMessageItemText(value: unknown): string | null {
  const item = asRecord(value)
  if (item?.type !== 'UserMessage' || !Array.isArray(item.content)) return null
  const parts = item.content.map(part => asRecord(part)).filter(part => part !== null)
  const text = parts
    .filter(part => part!.type === 'text' && typeof part!.text === 'string')
    .map(part => part!.text as string)
    .join('')
  if (text.length > 0) return text
  return parts.some(part => part!.type !== 'text') ? '[Image]' : null
}

export class CodexConversationSource implements ConversationSource {
  readonly provider = 'codex' as const
  private downgradeReason: string | null = null
  // What one discovery skipped (review of #1411, c): a skipped rollout or index
  // row used to leave the result looking complete. The counts reach the
  // discovery span, lastDowngradeReason and one console warning (counts only,
  // never paths). The picker itself has no degraded indicator for any source
  // yet, including the existing no-index downgrade; that is a residual.
  private skipped = { rollouts: 0, indexRows: 0 }
  private walk: { at: number; files: Map<string, { mtime: number | null; id: string }> } | null = null
  private readonly heads = new Map<string, { mtime: number; head: RolloutHead }>()
  // Rollout paths learnt at discovery, so a search that reads prompts for a
  // hundred and fifty rows does not open the index once per row.
  private readonly rolloutPaths = new Map<string, string>()

  constructor(private readonly deps: { codexHome: string; walkTtlMs?: number }) {}

  lastDowngradeReason(): string | null {
    return this.downgradeReason
  }

  // WHY the walk never stats: two thousand rollouts on the author's machine
  // are two thousand sequential stat calls (200 ms) to learn mtimes that
  // only the handful of unindexed files ever use. The directory entries say
  // what is a file; fromHead stats the file it is about to read.
  private async walkRollouts(): Promise<Map<string, { mtime: number | null; id: string }>> {
    const ttl = this.deps.walkTtlMs ?? DEFAULT_WALK_TTL_MS
    if (this.walk && Date.now() - this.walk.at < ttl) return this.walk.files
    const files = new Map<string, { mtime: number | null; id: string }>()
    const visit = async (dir: string, depth: number): Promise<void> => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory() && depth < 3) await visit(full, depth + 1)
        else if (entry.isFile()) {
          const m = ROLLOUT_RE.exec(entry.name)
          if (m) files.set(full, { mtime: null, id: m[2]! })
        }
      }
    }
    await visit(join(this.deps.codexHome, 'sessions'), 0)
    this.walk = { at: Date.now(), files }
    return files
  }

  private async fromHead(file: string, knownMtime: number | null, id: string, scope: SourceScope): Promise<SourceConversation | null> {
    let mtime = knownMtime
    if (mtime === null) {
      try {
        mtime = (await stat(file)).mtimeMs
      } catch {
        return null
      }
    }
    const cached = this.heads.get(file)
    let head: RolloutHead
    if (cached && cached.mtime === mtime) head = cached.head
    else {
      // WHY one unreadable rollout is skipped here (#1251 row 8): readline's
      // async iterator rethrows a stream error (EACCES, EIO, a file removed
      // between the walk and the read), and both callers await this in a plain
      // loop, so a single rollout the app cannot open used to reject
      // discover() and empty the whole Codex column. Skipping costs exactly
      // the row that cannot be labelled anyway (without its head there is no
      // cwd to scope it by). Nothing is cached, so the next discovery retries
      // it once the file is readable again.
      try {
        head = await readRolloutHead(file)
      } catch {
        this.skipped.rollouts++
        return null
      }
    }
    this.heads.set(file, { mtime, head })
    if (scope.scope !== 'everywhere' && !scope.family.matches(head.cwd)) return null
    return {
      provider: 'codex',
      nativeId: id,
      cwd: head.cwd,
      gitBranch: head.gitBranch,
      customTitle: null,
      aiTitle: null,
      userTexts: head.userTexts,
      createdAt: head.createdAt,
      lastUserActivityAt: head.lastUserAt,
      ...(head.headTruncated ? { headTruncated: true } : {}),
      activitySource: head.lastUserAt !== null ? 'tail' : null,
      mtime,
      promptCount: null,
      parentNativeId: null,
      isNativeSubagent: head.source !== null && head.source.includes('"subagent"'),
      isExec: head.source === 'exec',
      originator: head.originator,
      origin: 'scan',
      available: true,
      file,
    }
  }

  private withSkipped(reason: string | null): string | null {
    const { rollouts, indexRows } = this.skipped
    if (!rollouts && !indexRows) return reason
    const note = `skipped ${rollouts} unreadable rollout(s) and ${indexRows} malformed index row(s)`
    console.warn(`[conversations.codex] ${note}`)
    return reason ? `${reason}; ${note}` : note
  }

  async discover(scope: SourceScope): Promise<SourceConversation[]> {
    const span = performanceService.span('conversations.codex.discover', { scope: scope.scope })
    this.skipped = { rollouts: 0, indexRows: 0 }
    const dbPath = newestCodexStateDb(this.deps.codexHome)
    const opened = dbPath
      ? openReadOnlySqlite(dbPath, CODEX_INDEX_COLUMNS)
      : { ok: false as const, reason: `no state_N.sqlite under ${this.deps.codexHome}` }
    if (!opened.ok) {
      const rows = await this.scanEverything(scope)
      this.downgradeReason = this.withSkipped(opened.reason)
      span.end({ mode: 'scan', rows: rows.length, ...this.skipped })
      return rows
    }
    this.downgradeReason = null
    const rows: SourceConversation[] = []
    // WHY the known set covers EVERY indexed thread, not the family's rows:
    // "unindexed" means the index has never seen the thread. The first cut
    // filled this set from the family-filtered query, so every rollout of
    // another project or an archived thread looked unindexed and had its head
    // read on each cold discovery: nine hundred files, seven seconds. Ids are
    // tracked as well as paths because the recorded store holds two rollout
    // files for one thread id (a copy under another filename timestamp).
    const indexedPaths = new Set<string>()
    const indexedIds = new Set<string>()
    try {
      for (const known of opened.db.prepare('select id, rollout_path from threads').all() as Array<{ id: string; rollout_path: string | null }>) {
        indexedIds.add(known.id)
        if (known.rollout_path) indexedPaths.add(known.rollout_path)
      }
      const parents = new Map<string, string>()
      for (const edge of opened.db.prepare('select parent_thread_id, child_thread_id from thread_spawn_edges').all() as Array<{ parent_thread_id: string; child_thread_id: string }>) {
        parents.set(edge.child_thread_id, edge.parent_thread_id)
      }
      // WHY the family predicate runs in SQL: 1,133 of 2,007 rows are this
      // repository's; filtering in SQL keeps the JS side proportional to the
      // answer. lower() keeps darwin's case-insensitive cwds equal.
      const predicates: string[] = []
      const args: string[] = []
      // WHY the bound values are lowercased here too: the family lowercases
      // only on case-insensitive platforms, and `lower(cwd) = ?` against a
      // mixed-case root would never match on linux while the LIKE clause
      // still would, silently dropping every row recorded at the repo root.
      if (scope.scope === 'cwd') {
        predicates.push('lower(cwd) = ?')
        args.push(scope.family.cwd.toLowerCase())
      } else if (scope.scope === 'repository') {
        for (const root of scope.family.roots.map(r => r.toLowerCase())) {
          predicates.push('lower(cwd) = ?', "lower(cwd) like ? escape '\\'")
          args.push(root, root.replace(/[\\%_]/g, '\\$&') + '/%')
        }
      }
      const where = predicates.length > 0 ? `where archived = 0 and (${predicates.join(' or ')})` : 'where archived = 0'
      const columns = CODEX_INDEX_COLUMNS.threads.map(c => `"${c}"`).join(', ')
      for (const raw of opened.db.prepare(`select ${columns} from threads ${where}`).all(...args) as Array<Record<string, unknown>>) {
        const row = normalizeIndexRow(raw)
        if (!row) {
          this.skipped.indexRows++
          continue
        }
        this.rolloutPaths.set(row.id, row.rollout_path)
        const title = (row.title ?? '').trim() || (row.first_user_message ?? '').trim() || (row.preview ?? '').trim()
        const name = (row.name ?? '').trim()
        rows.push({
          provider: 'codex',
          nativeId: row.id,
          cwd: row.cwd || null,
          gitBranch: row.git_branch || null,
          // Codex fills `name` with a truncation of the first prompt unless the
          // user renamed the thread; a name that prefixes the title is the
          // former and carries less than the title does.
          customTitle: name && !title.startsWith(name) ? name : null,
          aiTitle: null,
          userTexts: title ? [title] : [],
          createdAt: row.created_at_ms ?? null,
          lastUserActivityAt: row.recency_at_ms ?? row.updated_at_ms ?? null,
          activitySource: row.recency_at_ms !== null || row.updated_at_ms !== null ? 'index' : null,
          mtime: row.updated_at_ms ?? 0,
          promptCount: null,
          parentNativeId: parents.get(row.id) ?? null,
          isNativeSubagent: isSubagentSource(row),
          isExec: row.source === 'exec',
          originator: row.originator ?? null,
          origin: 'index',
          available: existsSync(row.rollout_path),
          file: row.rollout_path,
        })
      }
    } finally {
      opened.close()
    }
    // Union with rollouts the index never recorded.
    const files = await this.walkRollouts()
    for (const [file, meta] of files) {
      if (indexedPaths.has(file) || indexedIds.has(meta.id)) continue
      const row = await this.fromHead(file, meta.mtime, meta.id, scope)
      if (row) rows.push(row)
    }
    this.downgradeReason = this.withSkipped(null)
    span.end({ mode: 'index', rows: rows.length, unindexed: rows.filter(r => r.origin === 'scan').length, ...this.skipped })
    return rows
  }

  /** Degraded path: the local head reader over every rollout, bounded by the
   *  family. Slow (the old picker's cost) but never empty. */
  private async scanEverything(scope: SourceScope): Promise<SourceConversation[]> {
    const files = await this.walkRollouts()
    const rows: SourceConversation[] = []
    for (const [file, meta] of files) {
      const row = await this.fromHead(file, meta.mtime, meta.id, scope)
      if (row) rows.push(row)
    }
    return rows
  }

  async prompts(nativeId: string, _cwd: string, options: PromptReadOptions = {}): Promise<ConversationPrompt[]> {
    // isPresent, not existsSync (#1434 round 1, a/b): existsSync answers false
    // for EACCES too, so a known rollout under a locked directory read as
    // "absent" and the conversation as having no prompts.
    const known = this.rolloutPaths.get(nativeId)
    let file: string | null = known && await isPresent('codex', known) ? known : null
    const dbPath = file ? null : newestCodexStateDb(this.deps.codexHome)
    const opened = dbPath ? openReadOnlySqlite(dbPath, { threads: ['id', 'rollout_path'] }) : null
    // An index that is THERE but cannot be opened (corrupt, locked, an older
    // schema) cannot tell us where the rollout is. The walk below may still
    // find it; if it does not, "not found" is unknown, not "no prompts".
    const indexUnknown = dbPath !== null && opened !== null && !opened.ok && await isPresent('codex', dbPath)
    if (opened?.ok) {
      try {
        const row = opened.db.prepare('select rollout_path from threads where id = ?').get(nativeId) as { rollout_path: string } | undefined
        if (row && await isPresent('codex', row.rollout_path)) file = row.rollout_path
      } finally {
        opened.close()
      }
    }
    if (!file) {
      const sessionsDir = join(this.deps.codexHome, 'sessions')
      // The package's walk swallows its own readdir errors (it answers null),
      // so an unreadable sessions tree would still read as "no prompts". Probe
      // the root here: absent is "not here", anything else is unknown.
      try {
        await readdir(sessionsDir)
      } catch (error) {
        if (!isMissingFileError(error)) throw new ConversationPromptsUnreadable('codex', error)
      }
      try {
        file = await findCodexRolloutPathByThreadId(sessionsDir, nativeId)
      } catch (error) {
        // Only absence is "not here" (#1306, steering q116): a rollout walk
        // that fails for any other reason is unknown, never "no prompts".
        if (!isMissingFileError(error)) throw new ConversationPromptsUnreadable('codex', error)
        file = null
      }
      if (!file) {
        // The package's walk skips every directory below the root it cannot
        // list (RolloutLocator.collectMatches), so "not found" can mean "in a
        // locked sessions/YYYY/MM/DD". Prove the tree was listable before
        // calling it absent (#1434 round 1, a/b). Only on this miss path.
        await assertTreeListable('codex', sessionsDir, 3, name => name.endsWith('.jsonl') && name.includes(nativeId))
        if (indexUnknown) throw new ConversationPromptsUnreadable('codex', new Error('the Codex state index exists but could not be opened, and no rollout was found by walking'))
      }
    }
    if (!file) return []
    // #1306: a found rollout that cannot be read is said, typed, not raw.
    const { prompts } = await extractPromptsFromFile('codex', nativeId, file, options.need ?? 'all', { maxBytes: options.maxBytes })
      .catch((error: unknown) => {
        if (isMissingFileError(error)) return { prompts: [] }
        throw new ConversationPromptsUnreadable('codex', error)
      })
    return prompts.map(p => ({ text: p.text, timestamp: p.ts }))
  }
}
