import { join } from 'node:path'

import type {
  Conversation, ConversationChildrenRequest, ConversationListRequest, ConversationListResponse,
  ConversationPrompt, ConversationPromptsRequest,
} from '@shared/conversations/types.js'
import { conversationKey } from '@shared/conversations/types.js'
import { getCodexHome } from '@providers/codex/runtime/projectDir.js'
import { getClaudeConfigHomeDir, getProjectsDir } from '@shared/runtime/projectDir.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { getHostTranscriptAdapter } from '@main/providerSwitch/transcriptEngine.js'
import { buildListing } from './catalog/listing.js'
import { normalizeConversation } from './catalog/normalize.js'
import { unwrapUserText } from './catalog/unwrap.js'
import { resolveFamily, type RepositoryFamily } from './family.js'
import type { ConversationLedger } from './ledger/ledger.js'
import type { LedgerRow } from './ledger/types.js'
import { ClaudeConversationSource } from './sources/claude.js'
import { ClaudeHistoryIndex } from './sources/claudeHistory.js'
import { CodexConversationSource } from './sources/codex.js'
import { defaultOpencodeDataDir, OpencodeConversationSource } from './sources/opencode.js'
import type { ConversationSource, SourceConversation } from './sources/types.js'

// The single consumer of the catalog and the single owner of caches.
//
// WHY discovery is cached per family for a short window: the picker fires a
// listing on open and again from its debounced search effect; a keystroke
// must not walk the Claude project dirs twice. Index reads are cheap (tens
// of milliseconds on the recorded store), Claude head/tail reads are cached
// per file by mtime+size inside the adapter, so the freshness window only
// has to cover one picker interaction. Nothing here is persisted: a fresh
// discovery after the window is what makes a session started in another
// terminal appear without a restart.
//
// WHY prompt search for Codex and OpenCode is bounded to the newest rows:
// their prompts live in the transcripts, not in an index. The incremental
// folder reads a tail window per file; two hundred files is one bounded pass
// and the result is cached here by the row's activity stamp, so a second
// keystroke costs nothing. Claude prompts come from history.jsonl for free.
//
// WHY `@main/ipc/git.js` is not imported here: its first line imports
// electron, and the system tests run this file under plain Node against the
// recorded corpus. The worktree lister is a dependency the boot code passes.

const DISCOVERY_FRESH_MS = 3_000
const SEARCH_PROMPT_ROWS = 200
const SEARCH_PROMPTS_PER_ROW = 40

type Discovery = { at: number; key: string; family: RepositoryFamily; sources: SourceConversation[] }

export type ListWorktrees = (cwd: string) => Promise<ReadonlyArray<{ path: string }>>

export class ConversationService {
  private discovery: Discovery | null = null
  private inflight: { key: string; promise: Promise<Discovery> } | null = null
  private discoveries = 0
  private readonly promptCache = new Map<string, { at: number; texts: string[] }>()

  constructor(private readonly deps: {
    sources: ConversationSource[]
    ledger: ConversationLedger | null
    listWorktrees: ListWorktrees
    claudeHistory: ClaudeHistoryIndex | null
  }) {}

  discoveriesForTests(): number {
    return this.discoveries
  }

  private async discover(request: Pick<ConversationListRequest, 'cwd' | 'scope'>): Promise<Discovery> {
    const key = `${request.scope}|${request.cwd}`
    const now = Date.now()
    if (this.discovery && this.discovery.key === key && now - this.discovery.at < DISCOVERY_FRESH_MS) return this.discovery
    // Coalesce only identical requests: a scope change mid-flight must not be
    // answered with the previous scope's rows.
    if (this.inflight && this.inflight.key === key) return this.inflight.promise
    const promise = (async () => {
      const span = performanceService.span('conversations.discover', { scope: request.scope })
      try {
        const family = await resolveFamily(request.cwd, request.scope, { listWorktrees: this.deps.listWorktrees })
        const perSource = await Promise.all(this.deps.sources.map(s => s.discover({ scope: request.scope, family }).catch((error: unknown) => {
          // One provider's store being unreadable must not empty the picker
          // for the other two; the row provenance already says which provider
          // is missing, and the live suite asserts counts per provider.
          // eslint-disable-next-line no-console
          console.warn(`[conversations] ${s.provider} discovery failed`, error)
          return [] as SourceConversation[]
        })))
        const discovery: Discovery = { at: Date.now(), key, family, sources: perSource.flat() }
        this.discovery = discovery
        this.discoveries++
        span.end({ rows: discovery.sources.length })
        return discovery
      } finally {
        // Only one flight per key can exist (identical keys coalesce above),
        // so clearing by key is clearing this flight.
        if (this.inflight?.key === key) this.inflight = null
      }
    })()
    this.inflight = { key, promise }
    return promise
  }

  private source(provider: Conversation['provider']): ConversationSource | null {
    return this.deps.sources.find(s => s.provider === provider) ?? null
  }

  private ledgerRows(): ReadonlyMap<string, LedgerRow> {
    return this.deps.ledger?.rows() ?? new Map<string, LedgerRow>()
  }

  private async promptTextsFor(rows: readonly Conversation[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    const candidates = [...rows].sort((a, b) => b.lastUserActivityAt - a.lastUserActivityAt).slice(0, SEARCH_PROMPT_ROWS)
    await Promise.all(candidates.map(async row => {
      const key = conversationKey(row.provider, row.nativeId)
      if (row.provider === 'claude' && this.deps.claudeHistory) {
        out.set(key, this.deps.claudeHistory.bySession(row.nativeId).map(p => p.text))
        return
      }
      const cached = this.promptCache.get(key)
      if (cached && cached.at === row.lastUserActivityAt) {
        out.set(key, cached.texts)
        return
      }
      const source = this.source(row.provider)
      if (!source || !row.available || !row.cwd) return
      try {
        const prompts = await source.prompts(row.nativeId, row.cwd)
        const texts = prompts.slice(0, SEARCH_PROMPTS_PER_ROW).map(p => p.text)
        this.promptCache.set(key, { at: row.lastUserActivityAt, texts })
        out.set(key, texts)
      } catch {
        // An unreadable transcript degrades this row to label-only search.
      }
    }))
    return out
  }

  async list(request: ConversationListRequest): Promise<ConversationListResponse> {
    const startedAt = Date.now()
    const discovery = await this.discover(request)
    const ledger = this.ledgerRows()
    if (!request.query?.trim()) {
      return buildListing({ sources: discovery.sources, ledger, family: discovery.family, request, startedAt })
    }
    // Search needs prompt texts: normalise once to know the rows, gather
    // texts for the newest ones, then build the listing with them attached.
    const rows = discovery.sources.map(s => normalizeConversation(s, ledger.get(conversationKey(s.provider, s.nativeId)) ?? null, discovery.family))
    const texts = await this.promptTextsFor(rows)
    return buildListing({
      sources: discovery.sources, ledger, family: discovery.family, request, startedAt,
      promptsFor: row => texts.get(conversationKey(row.provider, row.nativeId)) ?? [],
    })
  }

  async prompts(request: ConversationPromptsRequest): Promise<ConversationPrompt[]> {
    const source = this.source(request.provider)
    if (!source) return []
    const raw = await source.prompts(request.nativeId, request.cwd)
    // The folder reports wrappers verbatim; the prompt list shows what the
    // user typed, so unwrap here and drop injected messages.
    return raw.flatMap(p => {
      const unwrapped = unwrapUserText(p.text)
      return unwrapped ? [{ text: unwrapped.text, timestamp: p.timestamp }] : []
    })
  }

  async children(request: ConversationChildrenRequest): Promise<Conversation[]> {
    const discovery = await this.discover({ cwd: request.cwd, scope: 'repository' })
    const ledger = this.ledgerRows()
    return discovery.sources
      .map(s => normalizeConversation(s, ledger.get(conversationKey(s.provider, s.nativeId)) ?? null, discovery.family))
      .filter(r => r.parentNativeId === request.nativeId)
      .sort((a, b) => b.lastUserActivityAt - a.lastUserActivityAt)
  }
}

/** Production wiring against the real provider stores. */
export function createConversationService(deps: { ledger: ConversationLedger | null; listWorktrees: ListWorktrees }): ConversationService {
  const claudeHistory = new ClaudeHistoryIndex(join(getClaudeConfigHomeDir(), 'history.jsonl'))
  return new ConversationService({
    sources: [
      new ClaudeConversationSource({ projectsDir: getProjectsDir(), history: claudeHistory }),
      new CodexConversationSource({ codexHome: getCodexHome() }),
      new OpencodeConversationSource({
        dataDir: defaultOpencodeDataDir(),
        // OpenCode prompts are listed by its transcript adapter, which speaks
        // to the CLI's own session store; the source only needs the rows.
        listPrompts: (cwd, id) => getHostTranscriptAdapter('opencode').listPrompts(cwd, id).then(rows => rows.map(r => ({ text: r.text, timestamp: r.timestamp }))),
      }),
    ],
    ledger: deps.ledger,
    listWorktrees: deps.listWorktrees,
    claudeHistory,
  })
}
