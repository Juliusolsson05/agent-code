import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ConversationPrompt } from '@shared/conversations/types.js'
import { parseJsonRecord } from '@shared/lib/asRecord.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { openReadOnlySqlite } from './sqlite.js'
import type { ConversationSource, SourceConversation, SourceScope } from './types.js'

// OpenCode keeps every session in ~/.local/share/opencode/opencode.db:
// `session` (id, parent_id, directory, title, time_created, time_updated,
// time_archived) with messages in `message` (data JSON with `role`) and their
// text in `part` (data JSON with `type: "text"`, `text`, and `synthetic: true`
// on compaction continuations). Issue #773 asked for this list; the CLI's
// `session list --format json` is the same table one process spawn away, so
// the database is read directly and the CLI stays the transcript adapter's
// concern (export/import).
//
// WHY the title is an ai-title and never a provider-name: OpenCode generates
// it; a user rename is indistinguishable in the schema, so the ladder treats
// it as generated and prefers a real first prompt only when the title is
// empty. The one title the app itself writes (`createEmptyOpencodeSession`)
// is a placeholder and is reported as no title at all, so a session with no
// prompt classifies as empty.

export const OPENCODE_COLUMNS = {
  session: ['id', 'parent_id', 'directory', 'title', 'time_created', 'time_updated', 'time_archived'],
  message: ['id', 'session_id', 'time_created', 'data'],
  part: ['message_id', 'session_id', 'time_created', 'data'],
}

/** Title the app assigns when it creates an OpenCode Terminal session before
 *  the user has typed anything (src/providers/opencode/runtime/
 *  opencodeCliSessions.ts). Kept as a literal here on purpose: the catalog
 *  layer must not import provider runtime code. */
export const OPENCODE_PLACEHOLDER_TITLE = 'Agent Code terminal session'

const USER_TEXTS = 4

export function defaultOpencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME
  return xdg && xdg.length > 0 ? join(xdg, 'opencode') : join(homedir(), '.local', 'share', 'opencode')
}

type SessionRow = {
  id: string
  parent_id: string | null
  directory: string
  title: string
  time_created: number
  time_updated: number
  time_archived: number | null
}

export class OpencodeConversationSource implements ConversationSource {
  readonly provider = 'opencode' as const

  constructor(private readonly deps: { dataDir: string }) {}

  async discover(scope: SourceScope): Promise<SourceConversation[]> {
    const span = performanceService.span('conversations.opencode.discover', { scope: scope.scope })
    const opened = openReadOnlySqlite(join(this.deps.dataDir, 'opencode.db'), OPENCODE_COLUMNS)
    if (!opened.ok) {
      span.end({ mode: 'absent', reason: opened.reason })
      return []
    }
    const rows: SourceConversation[] = []
    try {
      const predicates: string[] = []
      const args: string[] = []
      // Lowercased on both sides: see the Codex adapter for why the family's
      // platform-dependent folding is not enough for `lower(directory) = ?`.
      if (scope.scope === 'cwd') {
        predicates.push('lower(directory) = ?')
        args.push(scope.family.cwd.toLowerCase())
      } else if (scope.scope === 'repository') {
        for (const root of scope.family.roots.map(r => r.toLowerCase())) {
          predicates.push('lower(directory) = ?', "lower(directory) like ? escape '\\'")
          args.push(root, root.replace(/[\\%_]/g, '\\$&') + '/%')
        }
      }
      const where = predicates.length > 0 ? `where time_archived is null and (${predicates.join(' or ')})` : 'where time_archived is null'
      const sessions = opened.db.prepare(`select id, parent_id, directory, title, time_created, time_updated, time_archived from session ${where}`).all(...args) as unknown as SessionRow[]
      // First user texts: the oldest user messages' text parts, skipping
      // synthetic compaction continuations. One prepared statement per session
      // over an indexed column is cheaper than joining the whole part table.
      const parts = opened.db.prepare(
        `select p.data as part, m.data as message from part p join message m on m.id = p.message_id
         where m.session_id = ? order by m.time_created asc, p.time_created asc limit 40`,
      )
      for (const s of sessions) {
        const userTexts: string[] = []
        for (const r of parts.all(s.id) as unknown as Array<{ part: string; message: string }>) {
          const message = parseJsonRecord(r.message)
          const part = parseJsonRecord(r.part)
          if (message?.role !== 'user' || part?.type !== 'text' || part.synthetic === true) continue
          if (typeof part.text === 'string' && part.text.trim()) userTexts.push(part.text.trim())
          if (userTexts.length >= USER_TEXTS) break
        }
        const title = s.title?.trim() || null
        rows.push({
          provider: 'opencode',
          nativeId: s.id,
          cwd: s.directory || null,
          gitBranch: null,
          customTitle: null,
          aiTitle: title === OPENCODE_PLACEHOLDER_TITLE ? null : title,
          userTexts,
          createdAt: s.time_created ?? null,
          lastUserActivityAt: s.time_updated ?? null,
          activitySource: s.time_updated ? 'index' : null,
          mtime: s.time_updated ?? 0,
          promptCount: null,
          parentNativeId: s.parent_id ?? null,
          isNativeSubagent: s.parent_id !== null,
          isExec: false,
          originator: null,
          origin: 'index',
          available: true,
          file: null,
        })
      }
    } finally {
      opened.close()
    }
    span.end({ mode: 'index', rows: rows.length })
    return rows
  }

  // WHY the database and not the CLI export the transcript engine uses: an
  // export spawns the opencode binary once per session, and search asks for
  // the prompts of two hundred sessions at a time. The same indexed join that
  // discovery reads gives every user text part in one statement. Rewind keeps
  // the export because it needs the export's message positions as addresses.
  async prompts(nativeId: string, _cwd: string): Promise<ConversationPrompt[]> {
    const opened = openReadOnlySqlite(join(this.deps.dataDir, 'opencode.db'), OPENCODE_COLUMNS)
    if (!opened.ok) return []
    try {
      const rows = opened.db.prepare(
        `select p.data as part, m.data as message, m.time_created as created from part p join message m on m.id = p.message_id
         where m.session_id = ? order by m.time_created desc, p.time_created desc`,
      ).all(nativeId) as unknown as Array<{ part: string; message: string; created: number | null }>
      const out: ConversationPrompt[] = []
      for (const r of rows) {
        const message = parseJsonRecord(r.message)
        const part = parseJsonRecord(r.part)
        if (message?.role !== 'user' || part?.type !== 'text' || part.synthetic === true) continue
        if (typeof part.text !== 'string' || !part.text.trim()) continue
        out.push({ text: part.text.trim(), timestamp: typeof r.created === 'number' ? r.created : null })
      }
      return out
    } finally {
      opened.close()
    }
  }
}
