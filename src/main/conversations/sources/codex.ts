import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { ConversationPrompt } from '@shared/conversations/types.js'
import { asRecord } from '@shared/lib/asRecord.js'
import { streamJsonl } from '@shared/runtime/streamJsonl.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { extractPromptsFromFile } from '@main/conversations/prompts/promptFolder.js'
import { findCodexRolloutPathByThreadId } from 'codex-headless'
import { newestCodexStateDb, openReadOnlySqlite } from './sqlite.js'
import type { ConversationSource, SourceConversation, SourceScope, PromptReadOptions } from './types.js'

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
  let records = 0
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
    } else if (record.type === 'event_msg' && payload?.type === 'user_message' && typeof payload.message === 'string') {
      if (out.userTexts.length < 6) out.userTexts.push(payload.message)
      const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
      if (Number.isFinite(ts)) out.lastUserAt = ts
    }
    // WHY the limit is unconditional: a rollout whose first two hundred
    // records hold no user event (exec runs, synthesized transcripts) has
    // nothing further up the file the head can label it by, and reading such
    // files to the end made discovery cost the size of the store.
    if (records >= HEAD_RECORD_LIMIT) break
  }
  return out
}

export class CodexConversationSource implements ConversationSource {
  readonly provider = 'codex' as const
  private downgradeReason: string | null = null
  private walk: { at: number; files: Map<string, { mtime: number | null; id: string }> } | null = null
  private readonly heads = new Map<string, { mtime: number; head: RolloutHead }>()

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
    const head = cached && cached.mtime === mtime ? cached.head : await readRolloutHead(file)
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

  async discover(scope: SourceScope): Promise<SourceConversation[]> {
    const span = performanceService.span('conversations.codex.discover', { scope: scope.scope })
    const dbPath = newestCodexStateDb(this.deps.codexHome)
    const opened = dbPath
      ? openReadOnlySqlite(dbPath, CODEX_INDEX_COLUMNS)
      : { ok: false as const, reason: `no state_N.sqlite under ${this.deps.codexHome}` }
    if (!opened.ok) {
      this.downgradeReason = opened.reason
      const rows = await this.scanEverything(scope)
      span.end({ mode: 'scan', rows: rows.length })
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
      if (scope.scope === 'cwd') {
        predicates.push('lower(cwd) = ?')
        args.push(scope.family.cwd)
      } else if (scope.scope === 'repository') {
        for (const root of scope.family.roots) {
          predicates.push('lower(cwd) = ?', "lower(cwd) like ? escape '\\'")
          args.push(root, root.replace(/[\\%_]/g, '\\$&') + '/%')
        }
      }
      const where = predicates.length > 0 ? `where archived = 0 and (${predicates.join(' or ')})` : 'where archived = 0'
      const columns = CODEX_INDEX_COLUMNS.threads.map(c => `"${c}"`).join(', ')
      for (const row of opened.db.prepare(`select ${columns} from threads ${where}`).all(...args) as unknown as IndexRow[]) {
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
    span.end({ mode: 'index', rows: rows.length, unindexed: rows.filter(r => r.origin === 'scan').length })
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
    let file: string | null = null
    const dbPath = newestCodexStateDb(this.deps.codexHome)
    const opened = dbPath ? openReadOnlySqlite(dbPath, { threads: ['id', 'rollout_path'] }) : null
    if (opened?.ok) {
      try {
        const row = opened.db.prepare('select rollout_path from threads where id = ?').get(nativeId) as { rollout_path: string } | undefined
        if (row && existsSync(row.rollout_path)) file = row.rollout_path
      } finally {
        opened.close()
      }
    }
    if (!file) {
      try {
        file = await findCodexRolloutPathByThreadId(join(this.deps.codexHome, 'sessions'), nativeId)
      } catch {
        file = null
      }
    }
    if (!file) return []
    const { prompts } = await extractPromptsFromFile('codex', nativeId, file, options.need ?? 'all', { maxBytes: options.maxBytes })
    return prompts.map(p => ({ text: p.text, timestamp: p.ts }))
  }
}
