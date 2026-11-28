import { assertAntigravityExternalControlExcluded } from '@providers/antigravity/runtime/externalControl.js'
import { spawn } from 'node:child_process'

import { listAntigravityConversations } from 'antigravity-acp-headless'

import type { ConversationPrompt } from '@shared/conversations/types.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { getToolPath } from '@main/setup/toolchain.js'
import { liveAntigravityRows, replayAntigravityConversation } from '@providers/antigravity/runtime/antigravityHistory.js'
import { ConversationPromptsUnreadable, type ConversationSource, type PromptReadOptions, type SourceConversation, type SourceScope } from './types.js'

// The catalog waits for every source (service.ts), so a stalled agy (not
// signed in, mid self-update, offline) must not hold the whole picker. A
// listing that fails or times out is not retried for UNAVAILABLE_TTL_MS, so
// reopening the picker does not start another agy each time.
const LIST_DEADLINE_MS = 8_000
const UNAVAILABLE_TTL_MS = 60_000

// Antigravity conversation discovery through agy's own ACP server:
// session/list in a short-lived `agy acp` (the catalog), session/load replay
// for prompts of a conversation that is not open (antigravityHistory.ts).
//
// WHY not agy's files: its conversation index and transcripts are private
// SQLite (~/.gemini/antigravity-cli/conversation_summaries.db,
// conversations/<id>.db) owned by a closed, self-updating binary; ACP is the
// supported read path. session/list returns sessions made in agy's TUI too.
//
// WHY a missing agy lists nothing instead of failing: the catalog lists every
// provider on every open, and a user without Antigravity must not see an
// error for a provider they never installed.

export class AntigravityConversationSource implements ConversationSource {
  readonly provider = 'antigravity' as const

  private unavailableUntil = 0

  constructor(private readonly deps: { binary?: () => string; now?: () => number; listDeadlineMs?: number } = {}) {}

  private binary(): string {
    return this.deps.binary?.() ?? getToolPath('antigravity', 'agy')
  }

  async discover(scope: SourceScope): Promise<SourceConversation[]> {
    const span = performanceService.span('conversations.antigravity.discover', { scope: scope.scope })
    const now = this.deps.now ?? Date.now
    if (now() < this.unavailableUntil) {
      span.end({ mode: 'acp', rows: 0, unavailable: true, cached: true })
      return []
    }
    let listings
    try {
      await assertAntigravityExternalControlExcluded(process.cwd())
      const child = spawn(this.binary(), ['acp'], { stdio: ['pipe', 'pipe', 'pipe'] })
      child.stderr.on('data', () => {})
      const failed = new Promise<never>((_, reject) => child.once('error', reject))
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('agy did not list conversations in time')), this.deps.listDeadlineMs ?? LIST_DEADLINE_MS)
      })
      try {
        listings = await Promise.race([listAntigravityConversations(child.stdout, child.stdin), failed, deadline])
      } finally {
        clearTimeout(timer)
        child.kill()
      }
    } catch {
      this.unavailableUntil = now() + UNAVAILABLE_TTL_MS
      span.end({ mode: 'acp', rows: 0, unavailable: true })
      return []
    }
    const rows: SourceConversation[] = []
    for (const listing of listings) {
      if (scope.scope !== 'everywhere' && (!listing.cwd || !scope.family.matches(listing.cwd))) continue
      const updatedAt = listing.updatedAt ?? 0
      rows.push({
        provider: 'antigravity',
        nativeId: listing.sessionId,
        cwd: listing.cwd,
        gitBranch: null,
        customTitle: null,
        // agy generates the title itself (session_info_update).
        aiTitle: listing.title,
        userTexts: [],
        createdAt: null,
        lastUserActivityAt: updatedAt,
        activitySource: 'index',
        mtime: updatedAt,
        promptCount: null,
        parentNativeId: null,
        isNativeSubagent: false,
        isExec: false,
        originator: null,
        origin: 'index',
        available: true,
        file: null,
      })
    }
    span.end({ mode: 'acp', rows: rows.length })
    return rows
  }

  /**
   * Every user prompt, newest first: from the live pane, else an agy replay.
   *
   * WHY search gets no replay: catalog search asks up to 150 rows at once
   * (service.ts SEARCH_PROMPT_ROWS) with a bounded `need`, and each replay is
   * a whole agy process plus a full session/load. Search matches Antigravity
   * rows by their title (agy's generated one) instead; View Prompts, which
   * asks for one conversation with need 'all', still replays it.
   */
  async prompts(nativeId: string, cwd: string, options?: PromptReadOptions): Promise<ConversationPrompt[]> {
    const live = liveAntigravityRows(nativeId)
    if (!live && options?.need !== 'all') return []
    try {
      const rows = live ?? await replayAntigravityConversation(nativeId, cwd, { binary: this.binary() })
      return rows
        .filter(row => row.role === 'user' && typeof row.text === 'string' && row.text.trim().length > 0)
        .map(row => ({ text: row.text!, timestamp: row.timestamp }))
        .reverse()
    } catch (error) {
      throw new ConversationPromptsUnreadable('antigravity', error)
    }
  }
}
