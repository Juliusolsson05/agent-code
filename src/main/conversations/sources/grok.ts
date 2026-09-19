import {
  isGenuineUserItem,
  listAllGrokSessions,
  readGrokChatHistory,
  resolveGrokTranscriptPath,
  type GrokSessionListEntry,
} from 'grok-code-headless'

import type { ConversationPrompt } from '@shared/conversations/types.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import type { ConversationSource, SourceConversation, SourceScope } from './types.js'

// Grok conversation discovery: native's own sessions index. Every session
// directory under the Grok home carries a summary.json (id, cwd, titles,
// timestamps) — the same index native's resume picker reads — so the catalog
// lists native Grok conversations without spawning the CLI. Prompts come from
// the session's chat_history.jsonl: genuine user rows only, synthetic ones
// (reminders, interrupts, plan instructions) excluded by the package's own
// classifier, exactly as the renderer's mapper excludes them.
//
// WHY title is an ai-title and never a provider-name: `session_summary` and
// `generated_title` are both Grok-generated (the summary ladder in the catalog
// layer treats them like OpenCode's generated titles), and the fallback is the
// session id — never "Grok".
//
// WHY no cwd filtering happens here beyond what the index gives: the source
// returns every session with its cwd; repository-family scoping is the
// catalog's job (it already lowercases and family-matches for the SQLite
// sources — same treatment applies to a plain string field).

const USER_TEXTS = 4

export class GrokConversationSource implements ConversationSource {
  readonly provider = 'grok' as const

  constructor(private readonly deps: { grokHome?: string } = {}) {}

  async discover(scope: SourceScope): Promise<SourceConversation[]> {
    const span = performanceService.span('conversations.grok.discover', { scope: scope.scope })
    // The index is one directory walk in the package (newest-updated first);
    // scope filtering happens below so 'everywhere' costs the same one walk.
    const sessions = listAllGrokSessions({ grokHome: this.deps.grokHome })
    const familyCwds = scope.scope === 'cwd'
      ? [scope.family.cwd.toLowerCase()]
      : scope.scope === 'repository' ? scope.family.roots.map(root => root.toLowerCase()) : null
    const rows: SourceConversation[] = []
    for (const session of sessions) {
      if (familyCwds && !familyCwds.includes(session.cwd.toLowerCase())) continue
      rows.push(this.toRow(session))
    }
    span.end({ mode: 'index', rows: rows.length })
    return rows
  }

  async prompts(nativeId: string, cwd: string): Promise<ConversationPrompt[]> {
    const file = resolveGrokTranscriptPath(cwd, nativeId, this.deps.grokHome)
    let history: Awaited<ReturnType<typeof readGrokChatHistory>>
    try {
      history = await readGrokChatHistory(file)
    } catch {
      // An unreadable or missing history for a listed session yields no
      // prompts rather than failing the whole search; the index row remains.
      return []
    }
    const out: ConversationPrompt[] = []
    for (const { item } of history) {
      if (item.type !== 'user' || !isGenuineUserItem(item)) continue
      const text = item.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map(part => part.text.trim())
        .filter(text => text.length > 0)
        .join('\n')
      if (text.length > 0) out.push({ text, timestamp: null })
    }
    return out
  }

  private toRow(session: GrokSessionListEntry): SourceConversation {
    const title = session.title?.trim() || null
    const timestamps = [session.updatedAt, session.createdAt]
      .filter((value): value is string => typeof value === 'string')
      .map(value => Date.parse(value))
      .filter(value => Number.isFinite(value))
    const lastActivity = timestamps.length > 0 ? Math.max(...timestamps) : null
    return {
      provider: 'grok',
      nativeId: session.sessionId,
      cwd: session.cwd || null,
      gitBranch: null,
      customTitle: null,
      aiTitle: title === session.sessionId ? null : title,
      userTexts: [],
      createdAt: session.createdAt ? Date.parse(session.createdAt) || null : null,
      lastUserActivityAt: lastActivity,
      activitySource: lastActivity !== null ? 'index' : null,
      mtime: lastActivity ?? 0,
      promptCount: null,
      parentNativeId: null,
      isNativeSubagent: false,
      isExec: false,
      originator: null,
      origin: 'index',
      available: true,
      file: null,
    }
  }
}
