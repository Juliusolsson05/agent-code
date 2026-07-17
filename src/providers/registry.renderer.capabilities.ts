import type { ReactNode } from 'react'
import type { ConditionView } from '@shared/conditions-core/view'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { AGENT_PROVIDER_KINDS, type AgentProviderKind, isAgentProviderKind } from '@shared/types/providerKind'
import { CLAUDE_VIEWS } from '@providers/claude/renderer/conditions/views'
import { CODEX_VIEWS } from '@providers/codex/renderer/conditions/views'
import {
  renderClaudeToolResult,
  renderClaudeToolUse,
} from '@providers/claude/renderer/rows/dispatch'
import {
  renderCodexToolResult,
  renderCodexToolUse,
} from '@providers/codex/renderer/rows/dispatch'
import type {
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
import { CODEX_CONDITION_POLICY } from '@providers/codex/renderer/conditions/policy'
import { OPENCODE_IDENTITY } from '@providers/opencode/renderer/identity'
import { OPENCODE_CONDITION_POLICY } from '@providers/opencode/renderer/conditions/policy'
import { OPENCODE_VIEWS } from '@providers/opencode/renderer/conditions/views'
import {
  createOpencodeTranscriptEntryMapper,
  extractOpencodeProviderSessionId,
} from '@providers/opencode/renderer/transcript/mapper'
import { opencodeComposerSubmit } from '@providers/opencode/renderer/composerSubmit'
import {
  renderOpencodeToolUse,
  renderOpencodeToolResult,
} from '@providers/opencode/renderer/rows/dispatch'
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
  renderToolUse?: (
    block: ToolUseBlock,
    context?: { live?: boolean; streaming?: boolean; result?: ToolResultBlock | null },
  ) => ReactNode | undefined
  renderToolResult?: (
    block: ToolResultBlock,
    context: { sourceTool?: ToolUseBlock | null },
  ) => ReactNode | undefined
  /**
   * Does this tool_use name spawn a subagent the fleet row should own?
   * Provider-owned because the spawn vocabulary is provider-specific and
   * used to live as a hardcoded global name set in feed/lib/agentSpawnTools —
   * exactly the kind of "which provider says what" knowledge #394 pulls into
   * the registry. Claude records fanout as an `Agent` tool_use and (for
   * MCP-orchestrated sessions) `mcp__<server>__orchestration_create_agent`;
   * Codex as a `spawn_agent` function_call and the bare
   * `orchestration_create_agent`; opencode has no spawn tool yet. The shared
   * feed predicate (isAgentSpawnToolName) unions these so the committed and
   * grouping planes route identically (the P2c blind spot: 73 tracked
   * children, zero cards, because only 'Agent'/'spawn_agent' were known).
   * wait/list/read orchestration tools are deliberately excluded — they are
   * queries about the fleet, not spawns.
   */
  isSpawnTool: (name: string) => boolean
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
const isMcpOrchestrationCreateAgent = (name: string): boolean =>
  name === 'mcp__agent_code__orchestration_create_agent'

const claudeCapabilities: RendererProviderCapabilities = {
  id: 'claude',
  name: 'Claude Code',
  ...CLAUDE_IDENTITY,
  conditionViews: CLAUDE_VIEWS,
  renderToolUse: renderClaudeToolUse,
  renderToolResult: renderClaudeToolResult,
  // This capability is a broad spawn-name signal used by the feed's ownership
  // gate; it is not proof that a tracker or legacy fleet row can parse every
  // generation. Provider dispatch gets first refusal and the Agent Code adapter
  // validates its owned protocol before any shared fallback is considered.
  isSpawnTool: (name) => name === 'Agent' || isMcpOrchestrationCreateAgent(name),
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
  renderToolUse: renderCodexToolUse,
  renderToolResult: renderCodexToolResult,
  // Historical Codex rollouts committed Agent Code MCP spawns as a bare name.
  // Current MCP-inside-exec calls are not classified by executable source text,
  // and native `spawn_agent` still has generation-aware provider parsing before
  // the legacy tracker is allowed to participate.
  isSpawnTool: (name) => name === 'spawn_agent' || name === 'orchestration_create_agent',
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
  renderToolUse: renderOpencodeToolUse,
  renderToolResult: renderOpencodeToolResult,
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

// Shared predicate: does this tool_use spawn a subagent the fleet row
// should own? (Residue plan P2c — the 2026-06-21 dispatch-name blind
// spot: a session spawning via the built-in MCP orchestration server
// painted ZERO Task cards while state-snapshot.subAgents held 73 tracked
// children, because the interception only knew 'Agent'/'spawn_agent'.)
//
// Lives HERE (not in features/feed/lib, its pre-#493 home) because it is a
// pure union over each provider's RendererProviderCapabilities.isSpawnTool —
// provider vocabulary, owned by this registry. Moving it also cut the last
// value-level rendering/ → features/feed edge (#493 PR-2): the committed
// collector's task-notification join and the feed's fleet rows now share it
// through the providers layer, which BOTH may legally import.
//
// WHY union across ALL providers instead of resolving the caller's provider:
// the call sites differ. Block.tsx has the ProviderContext, but
// ConversationRow.tsx's grouping walk (isAgentBlock) does not thread a
// provider. A provider-agnostic union preserves the previous behavior EXACTLY
// — the old Set matched any of the three names regardless of provider — while
// still sourcing the names from the registry. Because each provider's spawn
// names are disjoint in practice (no backend emits another's spawn verb), the
// union is identical to a per-provider check for any real transcript.
export function isAgentSpawnToolName(name: string): boolean {
  return AGENT_PROVIDER_KINDS.some(kind =>
    getRendererProviderCapabilities(kind).isSpawnTool(name),
  )
}
