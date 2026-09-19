import {
  listAllGrokSessions,
  resolveGrokTranscriptPath,
  type GrokSessionListEntry,
} from 'grok-code-headless'
import { loadGrokSnapshotAt } from '@main/providerSwitch/grokTranscript.js'

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
// Scoping uses the shared family matcher (review finding): exact-cwd equality
// silently dropped sessions started in a repository subdirectory and any
// realpath alias — the same sessions the Codex and OpenCode sources keep.

const USER_TEXTS = 4

export class GrokConversationSource implements ConversationSource {
  readonly provider = 'grok' as const

  constructor(private readonly deps: { grokHome?: string } = {}) {}

  async discover(scope: SourceScope): Promise<SourceConversation[]> {
    const span = performanceService.span('conversations.grok.discover', { scope: scope.scope })
    // The index is one directory walk in the package (newest-updated first);
    // scope filtering happens below so 'everywhere' costs the same one walk.
    const sessions = listAllGrokSessions({ grokHome: this.deps.grokHome })
    const rows: SourceConversation[] = []
    for (const session of sessions) {
      if (scope.scope !== 'everywhere' && !scope.family.matches(session.cwd)) continue
      rows.push(this.toRow(session))
    }
    span.end({ mode: 'index', rows: rows.length })
    return rows
  }

  async prompts(nativeId: string, cwd: string): Promise<ConversationPrompt[]> {
    // Decode through the SAME snapshot loader the transcript engine uses
    // (review finding): the parser's decode drops the <user_info> bootstrap
    // preamble and unwraps <user_query>, so searches match what the user
    // actually typed — never workspace metadata, never raw tags. Newest first
    // per the source contract (search reads the first 40). The resolve itself
    // can throw on a deleted cwd, hence the whole body inside the try.
    let snapshot: Awaited<ReturnType<typeof loadGrokSnapshotAt>>
    try {
      snapshot = await loadGrokSnapshotAt(resolveGrokTranscriptPath(cwd, nativeId, this.deps.grokHome))
    } catch {
      return []
    }
    const texts: string[] = []
    for (const entry of snapshot.conversation.entries) {
      if (entry.kind !== 'message' || entry.role !== 'user') continue
      const text = entry.content
        .filter((part): part is { kind: 'text'; text: string } => part.kind === 'text')
        .map(part => part.text.trim())
        .filter(text => text.length > 0)
        .join('\n')
      if (text.length > 0) texts.push(text)
    }
    return texts.reverse().map(text => ({ text, timestamp: null }))
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
