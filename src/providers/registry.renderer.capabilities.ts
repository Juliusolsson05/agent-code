import type { ConditionView } from '@shared/conditions-core/view'
import type { Entry, ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'
import type { SemanticLiveBlock, SemanticLiveTurn } from '@renderer/session-runtime/state'
import { type AgentProviderKind, isAgentProviderKind } from '@shared/types/providerKind'
import { CLAUDE_VIEWS } from '@providers/claude/renderer/conditions/views'
import { CODEX_VIEWS } from '@providers/codex/renderer/conditions/views'
import { renderClaudeOperation } from '@providers/claude/renderer/rows/dispatch'
import { renderClaudeDurableEntry } from '@providers/claude/renderer/entries/dispatch'
import { classifyClaudeDurableEntry } from '@providers/claude/renderer/entries/classify'
import {
  collectClaudeTaskNotifications,
  taskNotificationFromEntry,
} from '@providers/claude/renderer/adapters/taskNotification'
import { fromClaudeAgentUse } from '@providers/claude/renderer/adapters/collaboration'
import { fromClaudeAgentCodeOrchestrationUse } from '@providers/claude/renderer/adapters/agentCodeOrchestration'
import { renderClaudeSemanticBlock } from '@providers/claude/renderer/semantic/dispatch'
import { renderCodexOperation } from '@providers/codex/renderer/rows/dispatch'
import { renderCodexDurableEntry } from '@providers/codex/renderer/entries/dispatch'
import { classifyCodexDurableEntry } from '@providers/codex/renderer/entries/classify'
import { fromCodexNativeSpawnUse } from '@providers/codex/renderer/adapters/collaboration'
import { fromCodexAgentCodeOrchestrationUse } from '@providers/codex/renderer/adapters/agentCodeOrchestration'
import { renderCodexSemanticBlock } from '@providers/codex/renderer/semantic/dispatch'
import type {
  ProviderOperationDecision,
  ProviderOperationInput,
  ProviderSemanticDecision,
  ProviderDurableEntryDecision,
  ProviderDurableEntryKind,
  ProviderDurableEntryInput,
  ProviderTaskNotification,
  PromptDeliveryResult,
  SemanticFoldPolicy,
  TranscriptEntryMapper,
} from '@shared/types/providerConfig'
import { CLAUDE_SEMANTIC_FOLD_POLICY } from '@providers/claude/renderer/semanticFoldPolicy'
import { CODEX_SEMANTIC_FOLD_POLICY } from '@providers/codex/renderer/semanticFoldPolicy'
import { OPENCODE_SEMANTIC_FOLD_POLICY } from '@providers/opencode/renderer/semanticFoldPolicy'
import { CLAUDE_IDENTITY } from '@providers/claude/renderer/identity'
import { claudeComposerSubmit } from '@providers/claude/renderer/composerSubmit'
import { CLAUDE_CONDITION_POLICY } from '@providers/claude/renderer/conditions/policy'
import { normalizeClaudeCompactionConditions } from '@providers/claude/renderer/conditions/compaction/model'
import { CODEX_CONDITION_POLICY } from '@providers/codex/renderer/conditions/policy'
import { OPENCODE_IDENTITY } from '@providers/opencode/renderer/identity'
import { OPENCODE_CONDITION_POLICY } from '@providers/opencode/renderer/conditions/policy'
import { OPENCODE_VIEWS } from '@providers/opencode/renderer/conditions/views'
import {
  createOpencodeTranscriptEntryMapper,
  extractOpencodeProviderSessionId,
} from '@providers/opencode/renderer/transcript/mapper'
import { opencodeComposerSubmit } from '@providers/opencode/renderer/composerSubmit'
import { renderOpencodeOperation } from '@providers/opencode/renderer/rows/dispatch'
import { renderOpencodeSemanticBlock } from '@providers/opencode/renderer/semantic/dispatch'
import { codexComposerSubmit } from '@providers/codex/renderer/composerSubmit'
import { CODEX_IDENTITY } from '@providers/codex/renderer/identity'
import {
  createClaudeTranscriptEntryMapper,
  extractClaudeProviderSessionId,
} from '@providers/claude/renderer/transcript/mapper'
import {
  createCodexTranscriptEntryMapper,
  extractCodexProviderSessionId,
} from '@providers/codex/renderer/transcript/mapper'

export type RendererProviderCapabilities = {
  id: AgentProviderKind
  name: string
  /**
   * Identity descriptor (#394 phase 2c-2): glyph for dense lists,
   * short label for badges/toggles, spawn-picker description, and the
   * provider-specific resume invocation (given an already shell-quoted
   * session id). These replace the hand-written ternaries that made a
   * third provider invisible across every identity surface (#394 §7).
   */
  glyph: string
  shortLabel: string
  spawnDescription: string
  resumeCommand: (quotedSessionId: string) => string
  /**
   * Alt-<key> chord letter for "split with this provider" (#394 phase
   * 4). Optional: the DEFAULT_PROVIDER is covered by the generic
   * split-vertical/-horizontal commands, and a provider without a
   * declared key still gets palette-only split commands — chords are
   * a scarce resource, palette entries aren't.
   */
  splitShortcutKey?: string
  conditionViews: Record<string, ConditionView>
  normalizeConditions?: (input: {
    snapshot: ProviderConditionSnapshot | null
    currentTurn: SemanticLiveTurn | null
    entries: readonly Entry[]
  }) => ProviderConditionSnapshot | null
  renderOperation: (input: ProviderOperationInput) => ProviderOperationDecision
  renderDurableEntry?: (
    input: ProviderDurableEntryInput,
  ) => ProviderDurableEntryDecision | undefined
  /**
   * Admit provider-authored durable rows before the ownership ledger. This is
   * intentionally separate from `renderDurableEntry`: observations are pure
   * data and must not instantiate React nodes merely to ask whether an entry
   * exists. Both capabilities delegate to the same provider-local classifier,
   * which prevents central raw-discriminator compatibility branches.
   */
  classifyDurableEntry: (entry: Entry) => ProviderDurableEntryKind | null
  /** Provider-owned durable carrier decoding used by correlated rows. The
   * shared feed may transport this map but must never recognize a provider's
   * raw transcript envelope itself. */
  collectTaskNotifications?: (
    entries: readonly Entry[],
  ) => ReadonlyMap<string, ProviderTaskNotification>
  /** Decode only provider-authored completion carriers. Ownership collection
   * uses presence plus the optional parent id to keep parentless carriers
   * visible without learning the provider's envelope syntax. */
  classifyTaskNotificationEntry?: (entry: Entry) => ProviderTaskNotification | null
  /** Provider-only semantic variants that cannot be represented as a generic
   * tool_use without dropping typed evidence. Shared live prose/reasoning and
   * ordinary function calls continue through the provider-neutral paths. */
  renderSemanticBlock?: (
    block: SemanticLiveBlock,
    context: {
      committedToolResults: ReadonlyMap<string, ToolResultBlock>
    },
  ) => ProviderSemanticDecision | undefined
  /**
   * Does this complete tool_use prove a subagent spawn operation the fleet row
   * can own? Provider-owned and schema-aware: a name is routing vocabulary,
   * not proof that ids/prompts/Agent Code namespace fields are parseable.
   * Every caller has the active provider, so cross-provider unioning would
   * only let one backend claim another backend's coincidentally named tool.
   */
  isSpawnTool: (block: ToolUseBlock) => boolean
  /**
   * Provider-owned transcript-line → feed-entry mapping (#394 phase
   * 2b). One fresh mapper per ingestion stream; see the
   * TranscriptEntryMapper docstring in providerConfig.ts for the
   * stateful-cursor rationale. Replaced the quadruplicated
   * per-provider mapping loops in useIpcSubscriptions /
   * initialHistory / history / previewModel.
   */
  createTranscriptEntryMapper: (initialTurnCursor?: string | null) => TranscriptEntryMapper
  /**
   * Pass-A identity capture: extract the durable provider session id
   * this raw line claims, or null. Claude: `sessionId` on any entry;
   * Codex: session_meta `payload.id`.
   */
  extractProviderSessionId: (raw: Record<string, unknown>) => string | null
  /**
   * Composer submit protocol (#394 phase 2c-4). Owns the provider's
   * paste/submit discipline (Codex: one atomic bracketed-paste+Enter;
   * Claude: prepares attachments, then delegates every finished prompt to the
   * main-owned delivery state machine — see
   * providers/claude/renderer/composerSubmit.ts). The call site keeps
   * the kind-agnostic machinery: pasteId minting, streaming-baseline
   * capture, composer clearing, draft preservation on throw.
   */
  composerSubmit: (io: ComposerSubmitIo) => Promise<void>
  /**
   * Whether this provider's composer accepts inline image
   * attachments. Gates draft-image accumulation (paste handler), the
   * pill strip, and post-submit draft clearing. Claude-only today.
   */
  supportsImageAttachments: boolean
  /**
   * Whether the feed seeds an optimistic local user entry at submit
   * time. Codex needs it (no reliable structured user message at
   * submit; the rollout row arrives late and reconciles). Claude gets
   * its user entry from the transcript synchronously enough not to.
   * The STORE calls stay at the call site — this flag only decides
   * whether they fire, keeping providers decoupled from the
   * workspace store.
   */
  usesOptimisticUserEcho: boolean
  /**
   * Condition policy (#394 phase 3): the per-provider data the
   * generic workspace condition selectors consume (attention set,
   * blocking-input set, priority-ordered dispatch badge rules,
   * composer picker kind). Replaced selectors.ts's hardcoded kind
   * lists and provider branches.
   */
  conditionPolicy: ProviderConditionPolicy
  /**
   * Turn-ownership policy for the semantic reducer (2026-07-06 fix).
   * Replaced foldEvent.ts's hardcoded `sessionKind === 'codex'/'claude'`
   * gates, which sent every third provider down Codex's strict path with
   * proxy-only recovery hatches that could never fire for a non-proxy
   * source. See SemanticFoldPolicy in providerConfig.ts and the concrete
   * providers/<kind>/renderer/semanticFoldPolicy.ts for the per-provider
   * WHYs.
   */
  semanticFoldPolicy: SemanticFoldPolicy
}

/** See providers/<kind>/renderer/conditions/policy.ts for the concrete
 *  policies and the WHY on each field's gating semantics. */
export type ProviderConditionPolicy = {
  /**
   * The presentation owner for every condition kind the provider can emit.
   *
   * WHY this is explicit instead of inferred from `conditionViews`, attention,
   * or one-off shared checks: those sets intentionally overlap without being
   * equivalent. AskUserQuestion is feed-owned with no outlet view, the slash
   * picker is composer-owned and deliberately non-attention, and compaction has
   * an outlet view while usually being non-actionable progress. Inferring one
   * concern from another recreated the exact invisible-condition failure that
   * the provider registry was introduced to prevent.
   */
  destinations: Readonly<Record<string, ConditionDestination>>
  /** Kinds that mark a backgrounded pane unread (visible-gated). */
  attentionKinds: ReadonlySet<string>
  /** Kinds that route keystrokes to the PTY instead of the composer
   *  (presence-gated). */
  actionKinds: ReadonlySet<string>
  /** Priority-ordered dispatch-badge rules; first match wins. Labels
   *  are free-form strings (deliberately wider than conditions-core's
   *  AttentionLevel — 'QUESTION' exists only here). */
  attentionLabels: ReadonlyArray<{
    kind: string
    label: string | ((state: unknown) => string | null)
  }>
  /** Condition kind whose state feeds the composer's slash-command
   *  dropdown; omitted when the provider has no picker condition. */
  composerPickerKind?: string
}

export type ConditionDestination =
  | 'condition-outlet'
  | 'feed-inline'
  | 'composer'
  | 'attention-only'
  | 'intentional-hidden'

/** IO bag for composerSubmit. Draft images are structural (not the
 *  workspace-store type) so provider impls and this registry never
 *  import workspaceState — the same cycle-avoidance rule as the rest
 *  of this file. */
export type ComposerSubmitIo = {
  sessionId: string
  input: string
  draftImages: Array<{ base64Data: string; mediaType: string; filename?: string }>
  send: (data: string, pasteId?: string) => Promise<void>
  deliverPrompt: (prompt: string, imagePaths?: string[]) => Promise<PromptDeliveryResult>
  pasteId: string
  getScreen: () => string | undefined
}

// Does a tool name identify Agent Code's OWN orchestration spawn verb? The
// server namespace is part of the contract, not decorative text. The former
// `mcp__<anything>__orchestration_create_agent` regex claimed arbitrary MCP
// servers and routed them into our subagent state model even though their
// inputs/results could be unrelated. Phase 7's explicit hierarchy requires
// those open-world tools to reach the bounded generic structured fallback;
// only `agent_code` is eligible for an Agent Code lifecycle card.
const claudeCapabilities: RendererProviderCapabilities = {
  id: 'claude',
  name: 'Claude Code',
  ...CLAUDE_IDENTITY,
  conditionViews: CLAUDE_VIEWS,
  normalizeConditions: normalizeClaudeCompactionConditions,
  renderOperation: renderClaudeOperation,
  renderDurableEntry: renderClaudeDurableEntry,
  classifyDurableEntry: classifyClaudeDurableEntry,
  collectTaskNotifications: collectClaudeTaskNotifications,
  classifyTaskNotificationEntry: taskNotificationFromEntry,
  renderSemanticBlock: renderClaudeSemanticBlock,
  isSpawnTool: block => Boolean(
    fromClaudeAgentUse(block) ||
    fromClaudeAgentCodeOrchestrationUse(block)?.operation === 'create-agent'
  ),
  createTranscriptEntryMapper: () => createClaudeTranscriptEntryMapper(),
  extractProviderSessionId: extractClaudeProviderSessionId,
  composerSubmit: claudeComposerSubmit,
  supportsImageAttachments: true,
  usesOptimisticUserEcho: false,
  conditionPolicy: CLAUDE_CONDITION_POLICY,
  semanticFoldPolicy: CLAUDE_SEMANTIC_FOLD_POLICY,
}

const codexCapabilities: RendererProviderCapabilities = {
  id: 'codex',
  name: 'Codex',
  ...CODEX_IDENTITY,
  conditionViews: CODEX_VIEWS,
  renderOperation: renderCodexOperation,
  renderDurableEntry: renderCodexDurableEntry,
  classifyDurableEntry: classifyCodexDurableEntry,
  renderSemanticBlock: renderCodexSemanticBlock,
  isSpawnTool: block => Boolean(
    fromCodexNativeSpawnUse(block) ||
    fromCodexAgentCodeOrchestrationUse(block)?.operation === 'create-agent'
  ),
  createTranscriptEntryMapper: (initialTurnCursor) =>
    createCodexTranscriptEntryMapper(initialTurnCursor ?? null),
  extractProviderSessionId: extractCodexProviderSessionId,
  composerSubmit: codexComposerSubmit,
  supportsImageAttachments: false,
  usesOptimisticUserEcho: true,
  conditionPolicy: CODEX_CONDITION_POLICY,
  semanticFoldPolicy: CODEX_SEMANTIC_FOLD_POLICY,
}

const opencodeCapabilities: RendererProviderCapabilities = {
  id: 'opencode',
  name: 'OpenCode',
  ...OPENCODE_IDENTITY,
  conditionViews: OPENCODE_VIEWS,
  // Evidence-backed rows only (live probe 2026-07-06): todowrite renders as
  // a real todo list; everything else falls through to the generic rows.
  renderOperation: renderOpencodeOperation,
  classifyDurableEntry: () => null,
  renderSemanticBlock: renderOpencodeSemanticBlock,
  // opencode has no subagent-spawn tool yet (no fleet fanout on this backend).
  isSpawnTool: () => false,
  createTranscriptEntryMapper: () => createOpencodeTranscriptEntryMapper(),
  extractProviderSessionId: extractOpencodeProviderSessionId,
  composerSubmit: opencodeComposerSubmit,
  supportsImageAttachments: false,
  usesOptimisticUserEcho: true,
  conditionPolicy: OPENCODE_CONDITION_POLICY,
  semanticFoldPolicy: OPENCODE_SEMANTIC_FOLD_POLICY,
}

const rendererProviderCapabilities: Record<AgentProviderKind, RendererProviderCapabilities> = {
  claude: claudeCapabilities,
  codex: codexCapabilities,
  opencode: opencodeCapabilities,
}

export function getRendererProviderCapabilities(id: string): RendererProviderCapabilities {
  // WHY this file exists separately from registry.renderer.ts:
  // feed rows need provider row dispatch, but registry.renderer.ts also imports
  // TileLeaf so TileTree can mount panes. Feed -> registry.renderer -> TileLeaf
  // -> Feed is a runtime cycle. This capability-only registry contains the
  // provider renderer tables that do not need TileLeaf, so hot feed paths can
  // route through provider-owned dispatch without depending on pane mounting.
  if (!isAgentProviderKind(id)) throw new Error(`Unknown provider: ${id}`)
  const provider = rendererProviderCapabilities[id]
  if (!provider) throw new Error(`Unknown provider: ${id}`)
  return provider
}

export function isAgentSpawnTool(block: ToolUseBlock, provider: AgentProviderKind): boolean {
  return getRendererProviderCapabilities(provider).isSpawnTool(block)
}

export function providerTaskNotificationFromEntry(
  entry: Entry,
  provider: AgentProviderKind,
): ProviderTaskNotification | null {
  return getRendererProviderCapabilities(provider).classifyTaskNotificationEntry?.(entry) ?? null
}

export function providerDurableEntryKind(
  entry: Entry,
  provider: AgentProviderKind,
): ProviderDurableEntryKind | null {
  return getRendererProviderCapabilities(provider).classifyDurableEntry(entry)
}
