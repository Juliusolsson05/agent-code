import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
  type ConversationEntry,
  type Entry,
  type ToolResultBlock,
  type ToolUseBlock,
} from '../../../shared/types/transcript'
// Direct file imports — parser files are pure TypeScript, safe for
// the renderer. Package entry points pull in Node deps (pty, fs).
import { detectCodexApproval } from '../../../shared/parsers/codexScreen'
import { extractAssistantInProgress } from '../../../shared/parsers/extractAssistant'
import {
  type BuriedPaneRecord,
  RATIO_DEFAULT,
  type SessionId,
  type SessionKind,
  type SessionMeta,
  type SplitDirection,
  type Tab,
  type TabId,
  type TileNode,
  type WorkspaceState,
} from './types'
import {
  adjustNearestSplitRatio,
  closeLeaf,
  collectLeaves,
  equalizeRatios,
  insertBesideLeaf,
  normalizeTree,
  resizeInDirection,
  rotateTree,
  splitLeaf,
  wrapRootWithLeaf,
} from './treeOps'
import { findBestRemainingFocus, findDirectionalNeighbor } from './geometry'
import {
  UndoCloseStack,
  findParentSplitInfo,
  reinsertPane,
  type ClosedEntry,
} from '../lib/undoClose'
import { useGlobalToast } from '../GlobalToast'
import {
  extractAssistantByUuid,
  assistantUuidsWithText,
} from '../copyAssistant'
import { useAppStore } from '../state/hooks'
import {
  emptySemanticRuntime,
  emptyRuntime,
  parseSemanticTodos,
  type FeedDebugEntry,
  type FeedDebugLayer,
  type PickerItem,
  type QueuedMessage,
  type ReaderModeState,
  type SemanticLiveBlock,
  type SemanticLiveTurn,
  type SemanticRuntimeState,
  type SessionRuntime,
  type SessionStatus,
  type SessionStatusSource,
  type SlashPickerState,
  type StreamPhase,
  type SpotlightState,
  type TileTabsState,
} from './workspaceState'
import {
  ghostsFromSemanticTurn,
  ghostsToPersist,
  reconcileUpstream,
} from './ghosts'
// Bootstrap uses the sans-superseded reducer because cc-shell only
// ever wants the provisional-and-still-live ghost set on resume —
// forensic "rendered X but upstream confirmed Y" rows are surfaced
// (if ever) through a dedicated UI, not the feed. Pairs with the
// `trustSupersededFlag` merge option in `./mergedEntries.ts`. See
// atp/src/ghost.ts for the full contract.
import { reduceGhostLogSansSuperseded as reduceGhostLog } from 'agent-transcript-parser/ghost'
import type { PlacementTarget } from '../features/workspace/lib/newAgentPlacement'

// Workspace store — single React hook that owns:
//   - The workspace state (tabs + tile trees + session metadata)
//   - Live per-session runtime state (screen, entries, awaitingAssistant, …)
//   - IPC subscriptions that dispatch events to the right session
//   - All the mutation actions the keybind system calls
//
// We deliberately keep everything in ONE hook instead of splitting into
// multiple stores because:
//   - The mutations cross-cut multiple slices (splitting creates a new
//     session AND adds to tree AND updates sessions map).
//   - The dispatch-by-sessionId event routing needs a stable reference
//     to the live state refs — one hook means one set of refs.
//   - Persistence is a single serialized blob; one store = one save.
//
// If this grows past ~500 lines we split, but for now it's manageable.

// ---------------------------------------------------------------------------
// Per-session runtime state (live; NOT persisted to disk)
// ---------------------------------------------------------------------------

const FEED_DEBUG_LOG_CAP = 500

type FeedDebugInput = {
  layer: FeedDebugLayer
  kind: string
  summary: string
  data?: unknown
}

function appendFeedDebugLog(
  current: SessionRuntime,
  input: FeedDebugInput,
): SessionRuntime {
  const ts = Date.now()
  const epoch = current.feedDebugEpochMs ?? ts
  const nextEntry: FeedDebugEntry = {
    id: current.feedDebugNextId,
    ts,
    tMs: ts - epoch,
    layer: input.layer,
    kind: input.kind,
    summary: input.summary,
    data: input.data,
  }
  const nextLog =
    current.feedDebugLog.length >= FEED_DEBUG_LOG_CAP
      ? [...current.feedDebugLog.slice(current.feedDebugLog.length - FEED_DEBUG_LOG_CAP + 1), nextEntry]
      : [...current.feedDebugLog, nextEntry]
  return {
    ...current,
    feedDebugEpochMs: epoch,
    feedDebugNextId: current.feedDebugNextId + 1,
    feedDebugLog: nextLog,
  }
}

function summarizeSemanticEventForDebug(event: Record<string, unknown>): string {
  const type = typeof event.type === 'string' ? event.type : 'unknown'
  const turnId = typeof event.turnId === 'string' ? event.turnId : null
  const source = typeof event.source === 'string' ? event.source : null
  const toolName = typeof event.toolName === 'string' ? event.toolName : null
  const blockIndex =
    typeof event.blockIndex === 'number' ? event.blockIndex : null
  const stopReason =
    typeof event.stopReason === 'string' ? event.stopReason : null
  const parts = [type]
  if (source) parts.push(`src=${source}`)
  if (turnId) parts.push(`turn=${turnId.slice(0, 10)}`)
  if (blockIndex !== null) parts.push(`block=${blockIndex}`)
  if (toolName) parts.push(`tool=${toolName}`)
  if (stopReason) parts.push(`stop=${stopReason}`)
  return parts.join(' ')
}

function summarizeEntryForDebug(entry: Entry): string {
  const text = entryTextContent(entry)
  if (text) {
    const compact = text.replace(/\s+/g, ' ').trim()
    return `${entry.type}: ${compact.slice(0, 96)}`
  }
  return entry.type
}


function isCodexRolloutEntry(entry: Record<string, unknown>): boolean {
  const type = entry.type
  return (
    type === 'session_meta' ||
    type === 'response_item' ||
    type === 'event_msg' ||
    type === 'turn_context' ||
    type === 'compacted'
  )
}

function extractCodexProviderSessionId(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'session_meta') return null
  const payload = entry.payload as Record<string, unknown> | undefined
  return typeof payload?.id === 'string' ? payload.id : null
}

function entryTextContent(entry: Entry): string | null {
  if (entry.type !== 'user' && entry.type !== 'assistant') return null
  const content = (entry as { message?: { content?: unknown } }).message?.content
  if (!Array.isArray(content)) return null
  const texts = content
    .map(block => {
      const item = block as Record<string, unknown>
      return item.type === 'text' && typeof item.text === 'string' ? item.text : null
    })
    .filter((text): text is string => text !== null)
  return texts.length > 0 ? texts.join('\n') : null
}

function sessionSpawnErrorMessage(
  kind: SessionKind,
  err: unknown,
  useProxy: boolean,
): string {
  const raw =
    err instanceof Error && err.message.length > 0
      ? err.message
      : String(err || `Failed to start ${kind}`)
  if (
    kind === 'claude' &&
    useProxy &&
    (
      raw.includes('Timed out waiting for mitmproxy') ||
      raw.includes('Unable to locate mitm') ||
      raw.includes('mitmdump')
    )
  ) {
    return 'Claude proxy startup failed. Disable Proxy Streaming in settings or restart the app after rebuilding.'
  }
  return raw
}

function isOptimisticCodexUserEntry(entry: Entry | undefined): boolean {
  if (!entry || entry.type !== 'user') return false
  return typeof entry.uuid === 'string' && entry.uuid.startsWith('optimistic-codex-user:')
}

function parseCodexJson(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function codexOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map(item => {
        if (typeof item === 'string') return item
        const rec = item as Record<string, unknown>
        return typeof rec.text === 'string' ? rec.text : JSON.stringify(item, null, 2)
      })
      .join('\n')
  }
  return JSON.stringify(output ?? '', null, 2)
}

function stripCodexExecWrapper(output: string): string {
  const marker = '\nOutput:\n'
  const idx = output.indexOf(marker)
  if (!output.startsWith('Chunk ID:') || idx === -1) return output
  return output.slice(idx + marker.length)
}

function isCodexExecWrapperOutput(output: string): boolean {
  return output.startsWith('Chunk ID:') && output.includes('\nProcess exited with code ')
}

function codexToolUseEntry(
  uuid: string,
  timestamp: string | undefined,
  id: string,
  name: string,
  input: unknown,
): Entry {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id,
          name,
          input,
        },
      ],
    },
  }
}

function codexAssistantTextEntry(
  uuid: string,
  timestamp: string | undefined,
  text: string,
): Entry {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  }
}

function codexToolResultEntry(
  uuid: string,
  timestamp: string | undefined,
  toolUseId: string,
  content: string,
  isError = false,
  codex?: Record<string, unknown>,
): Entry {
  const resultBlock = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError,
    codex,
  }

  return {
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp,
    message: {
      role: 'user',
      content: [resultBlock],
    },
  }
}

const SEMANTIC_LOG_CAP = 200
const SEMANTIC_HISTORY_CAP = 20
const SEMANTIC_ERROR_CAP = 20

function semanticToIndex(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function trimSemanticId(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  return s.length > 14 ? s.slice(0, 14) + '…' : s
}

function flattenSemanticUsage(
  u: Record<string, unknown>,
): Record<string, number | string | undefined> {
  const out: Record<string, number | string | undefined> = {}
  for (const [k, v] of Object.entries(u)) {
    if (typeof v === 'number' || typeof v === 'string') out[k] = v
    else if (v && typeof v === 'object') {
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof cv === 'number' || typeof cv === 'string') {
          out[`${k}.${ck}`] = cv
        }
      }
    }
  }
  return out
}

function semanticHistoryRow(
  turn: SemanticLiveTurn,
): Pick<SemanticLiveTurn, 'turnId' | 'text' | 'stopReason' | 'startedAt' | 'endedAt'> {
  return {
    turnId: turn.turnId,
    text: turn.text,
    stopReason: turn.stopReason,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
  }
}

function isSemanticTurnRunning(turn: SemanticLiveTurn | null): boolean {
  return turn !== null && turn.endedAt === null
}

function deriveSessionStatus(runtime: SessionRuntime): {
  sessionStatus: SessionStatus
  sessionStatusSource: SessionStatusSource
} {
  if (runtime.exited !== null) {
    return { sessionStatus: 'exited', sessionStatusSource: 'exit' }
  }
  if (isSemanticTurnRunning(runtime.semantic.currentTurn)) {
    return { sessionStatus: 'running', sessionStatusSource: 'semantic' }
  }
  if (runtime.processActive) {
    return { sessionStatus: 'running', sessionStatusSource: 'process' }
  }
  if (runtime.awaitingAssistant) {
    return { sessionStatus: 'running', sessionStatusSource: 'submit' }
  }
  return { sessionStatus: 'idle', sessionStatusSource: 'none' }
}

function withDerivedSessionStatus(runtime: SessionRuntime): SessionRuntime {
  return {
    ...runtime,
    ...deriveSessionStatus(runtime),
  }
}

function hasPendingSemanticTools(turn: SemanticLiveTurn): boolean {
  return Object.values(turn.blocks).some(block => {
    if (
      block.kind !== 'tool_use' &&
      block.kind !== 'server_tool_use' &&
      block.kind !== 'mcp_tool_use'
    ) {
      return false
    }
    return block.toolUseId != null && block.resultAt == null
  })
}

function emptySemanticTaskSnapshot() {
  return {
    todos: [],
    doneCount: 0,
    totalCount: 0,
    inProgressToolUseIds: [] as string[],
    activeToolNames: [] as string[],
  }
}

function emptySemanticLookupSnapshot(): SemanticLiveTurn['lookups'] {
  return {
    toolCallsById: {},
    toolUseIdsInOrder: [],
    resolvedToolUseIds: [],
    erroredToolUseIds: [],
  }
}

function deriveSemanticTaskSnapshot(
  blocks: Record<number, SemanticLiveTurn['blocks'][number]>,
): {
  task: SemanticLiveTurn['task']
  lookups: SemanticLiveTurn['lookups']
} {
  const inProgressToolUseIds: string[] = []
  const activeToolNames: string[] = []
  const resolvedToolUseIds: string[] = []
  const erroredToolUseIds: string[] = []
  const toolUseIdsInOrder: string[] = []
  const toolCallsById: SemanticLiveTurn['lookups']['toolCallsById'] = {}
  let todos = emptySemanticTaskSnapshot().todos

  // WHY derive a lookup snapshot here instead of teaching Feed to scan blocks
  // every render:
  //
  // Upstream Claude does not let render components rediscover tool state from
  // raw transcript rows. It builds a relationship layer first
  // (`toolUseByToolUseID`, `toolResultByToolUseID`, `resolvedToolUseIDs`,
  // sibling sets, progress maps) and then renders from that. This smaller
  // semantic lookup snapshot is the same idea for cc-shell's live turn: keep
  // the expensive / correctness-sensitive "which tool is still live, which one
  // errored, which tools were siblings in this turn?" logic in the shared
  // reducer so every surface reads the same answer.
  const orderedBlocks = Object.values(blocks).sort((a, b) => a.blockIndex - b.blockIndex)
  for (const block of orderedBlocks) {
    if (
      block.kind !== 'tool_use' &&
      block.kind !== 'server_tool_use' &&
      block.kind !== 'mcp_tool_use'
    ) {
      continue
    }
    const hasResult = block.resultAt != null
    if (block.toolUseId && !hasResult) {
      inProgressToolUseIds.push(block.toolUseId)
      if (block.toolName) activeToolNames.push(block.toolName)
    }
    if (block.toolUseId) {
      toolUseIdsInOrder.push(block.toolUseId)
      if (hasResult) {
        resolvedToolUseIds.push(block.toolUseId)
        if (block.resultIsError) erroredToolUseIds.push(block.toolUseId)
      }
      toolCallsById[block.toolUseId] = {
        toolUseId: block.toolUseId,
        blockIndex: block.blockIndex,
        kind: block.kind,
        toolName: block.toolName ?? null,
        status: block.resultIsError
          ? 'error'
          : hasResult
            ? 'completed'
            : 'in_progress',
        inputJson: block.inputJson ?? '',
        resultContent: block.resultContent ?? null,
      }
    }
    if (block.toolName === 'TodoWrite' && block.parsedInput) {
      todos = parseSemanticTodos(block.parsedInput)
    }
  }

  const dedupedToolNames = [...new Set(activeToolNames)]
  const doneCount = todos.filter(todo => todo.status === 'completed').length
  return {
    task: {
      todos,
      doneCount,
      totalCount: todos.length,
      inProgressToolUseIds,
      activeToolNames: dedupedToolNames,
    },
    lookups: {
      toolCallsById,
      toolUseIdsInOrder,
      resolvedToolUseIds,
      erroredToolUseIds,
    },
  }
}

function summarizeSemanticEvent(ev: Record<string, unknown>): string {
  const t = String(ev.type ?? '')
  switch (t) {
    case 'turn_started':
      return `turn_started ${trimSemanticId(ev.turnId)} (${ev.source ?? '?'})`
    case 'turn_delta': {
      const ft = typeof ev.fullText === 'string' ? ev.fullText : ''
      return `turn_delta len=${ft.length}`
    }
    case 'text_delta':
      return `text_delta idx=${ev.blockIndex} +${String(ev.textDelta ?? '').length}`
    case 'thinking_delta':
      return `thinking_delta idx=${ev.blockIndex} +${String(ev.thinkingDelta ?? '').length}`
    case 'connector_text_delta':
      return `connector_text_delta idx=${ev.blockIndex} +${String(ev.connectorTextDelta ?? '').length}`
    case 'citations_delta':
      return `citations_delta idx=${ev.blockIndex}`
    case 'tool_input_delta':
      return `tool_input_delta idx=${ev.blockIndex} ${ev.toolName ?? '?'}`
    case 'tool_input_finalized':
      return `tool_input_finalized idx=${ev.blockIndex} ${ev.toolName ?? '?'} ${ev.parsed ? '[ok]' : '[bad]'}`
    case 'block_started':
      return `block_started idx=${ev.blockIndex} ${ev.kind}${ev.toolName ? ` (${ev.toolName})` : ''}`
    case 'block_completed':
      return `block_completed idx=${ev.blockIndex} ${ev.kind}`
    case 'turn_stopped':
      return `turn_stopped ${ev.stopReason ?? '?'}`
    case 'turn_completed':
      return 'turn_completed'
    case 'usage_updated': {
      const u = ev.usage as Record<string, unknown> | undefined
      return `usage in=${u?.input_tokens ?? '?'} out=${u?.output_tokens ?? '?'}`
    }
    case 'flow_selected':
      return `flow_selected ${ev.flowId} — ${ev.reason}`
    case 'flow_ignored':
      return `flow_ignored ${ev.flowId} — ${ev.reason}`
    case 'api_error':
      return `api_error ${ev.errorType ?? ''} — ${String(ev.message ?? '').slice(0, 60)}`
    case 'stream_error':
      return `stream_error ${ev.errorType ?? ''} — ${String(ev.message ?? '').slice(0, 60)}`
    case 'source_changed':
      return `source_changed ${ev.previousSource ?? '?'} → ${ev.source ?? '?'}`
    case 'signature':
      return `signature idx=${ev.blockIndex}`
    case 'tool_result':
      return `tool_result ${trimSemanticId(ev.toolUseId)} ${ev.isError ? '[error]' : ''}`
    case 'tool_started':
      return `tool_started ${trimSemanticId(ev.callId)} ${String(ev.label ?? ev.tool ?? '')}`.trim()
    case 'tool_output_delta':
      return `tool_output_delta ${trimSemanticId(ev.callId)} +${String(ev.textDelta ?? '').length}`
    case 'tool_completed':
      return `tool_completed ${trimSemanticId(ev.callId)} exit=${String(ev.exitCode ?? '-')}`
    default:
      return t
  }
}

export function foldSemanticEvent(
  state: SemanticRuntimeState,
  ev: Record<string, unknown>,
  sessionKind: SessionKind,
): SemanticRuntimeState {
  // WHY centralize semantic folding here instead of letting Feed,
  // ReaderView, and the proxy debug UI each subscribe separately:
  //
  // The old architecture created three subtly different truths about the same
  // live turn. Feed still derived structure from screen scraping, Reader kept a
  // local semantic turn, and the debug panel had yet another reducer. That
  // split is exactly how we ended up under-using the proxy stream: every UI
  // surface only consumed the subset it happened to care about.
  //
  // The invariant now is "one session => one semantic reducer". Every semantic
  // event, including late tool_result and connector/citation deltas, must flow
  // through this fold before any UI reads it. If a future surface wants live
  // model structure, it should select from `runtime.semantic`, not open its own
  // transport subscription.
  const now = Date.now()
  const summary = summarizeSemanticEvent(ev)
  const logEntry = {
    id: state.nextLogId,
    type: String(ev.type ?? '?'),
    ts: now,
    summary,
    raw: ev,
  }
  const log = [...state.log, logEntry]
  if (log.length > SEMANTIC_LOG_CAP) {
    log.splice(0, log.length - SEMANTIC_LOG_CAP)
  }

  const t = String(ev.type ?? '')
  let flows = state.flows
  let currentTurn = state.currentTurn
  let history = state.history
  let errors = state.errors

  switch (t) {
    case 'flow_selected': {
      const flowId = String(ev.flowId ?? '')
      const prev = flows[flowId]
      flows = {
        ...flows,
        [flowId]: {
          flowId,
          attribution: 'active',
          reason: String(ev.reason ?? ''),
          turnId: typeof ev.turnId === 'string' ? ev.turnId : null,
          firstSeen: prev?.firstSeen ?? now,
          lastSeen: now,
          bytesEstimate: prev?.bytesEstimate ?? 0,
          chunkCount: prev?.chunkCount ?? 0,
        },
      }
      break
    }
    case 'flow_ignored': {
      const flowId = String(ev.flowId ?? '')
      const prev = flows[flowId]
      flows = {
        ...flows,
        [flowId]: {
          flowId,
          attribution: 'ignored',
          reason: String(ev.reason ?? ''),
          turnId: typeof ev.turnId === 'string' ? ev.turnId : null,
          firstSeen: prev?.firstSeen ?? now,
          lastSeen: now,
          bytesEstimate: prev?.bytesEstimate ?? 0,
          chunkCount: prev?.chunkCount ?? 0,
        },
      }
      break
    }
    case 'turn_started': {
      const turnId = String(ev.turnId ?? '')
      if (!turnId) break
      // Provider-gated turn ownership.
      //
      // Codex (strict): mismatched turnIds are DROPPED because they
      // come from racing producers (proxy flow + screen fallback, or
      // two concurrent proxy flows). Replacing currentTurn on their
      // say-so wipes the block map the live renderer is already
      // showing — the 0/1/0/1 flicker documented in
      // docs/superpowers/plans/2026-04-17-codex-semantic-flicker-fix.md.
      //
      // Claude (auto-replace): archive the stuck turn and open the
      // new one. Claude legitimately keeps currentTurn alive across
      // turn boundaries while a cross-turn tool_result is pending
      // (turn_completed below retains the turn when
      // hasPendingSemanticTools is true). The NEXT assistant turn's
      // message_start carries a fresh msg_id that mismatches the
      // pinned turnId; dropping it would silently hide every
      // subsequent Claude turn. This restores the reducer's pre-flicker-fix
      // behavior for Claude only. See
      // docs/superpowers/plans/2026-04-17-claude-semantic-provider-gating.md.
      //
      // Same-turnId refresh (re-entry / source promotion) is
      // identical for both providers.
      if (!currentTurn) {
        currentTurn = {
          turnId,
          text: '',
          source: typeof ev.source === 'string' ? ev.source : null,
          blocks: {},
          blockOrder: [],
          stopReason: null,
          usage: null,
          task: emptySemanticTaskSnapshot(),
          lookups: emptySemanticLookupSnapshot(),
          startedAt: now,
          endedAt: null,
        }
      } else if (currentTurn.turnId === turnId) {
        currentTurn = {
          ...currentTurn,
          source: typeof ev.source === 'string' ? ev.source : currentTurn.source,
        }
      } else if (sessionKind === 'claude') {
        history = [...history, semanticHistoryRow(currentTurn)].slice(-SEMANTIC_HISTORY_CAP)
        currentTurn = {
          turnId,
          text: '',
          source: typeof ev.source === 'string' ? ev.source : null,
          blocks: {},
          blockOrder: [],
          stopReason: null,
          usage: null,
          task: emptySemanticTaskSnapshot(),
          lookups: emptySemanticLookupSnapshot(),
          startedAt: now,
          endedAt: null,
        }
      }
      // Codex: mismatched turnId falls through — drop the event.
      break
    }
    case 'source_changed': {
      if (!currentTurn) break
      currentTurn = {
        ...currentTurn,
        source: typeof ev.source === 'string' ? ev.source : currentTurn.source,
      }
      break
    }
    case 'turn_delta': {
      const turnId = typeof ev.turnId === 'string' ? ev.turnId : null
      if (!turnId) break
      // Soft-open allowed when there's no currentTurn (e.g. Codex's
      // rollout agent_message_delta can arrive before task_started).
      //
      // On turnId mismatch:
      //   - Claude: archive the pinned old turn and open a new one.
      //     Same rationale as the turn_started branch above.
      //   - Codex: drop. Racing producers must not mutate a
      //     currentTurn that doesn't belong to them (flicker defense).
      if (!currentTurn) {
        currentTurn = {
          turnId,
          text: '',
          source: typeof ev.source === 'string' ? ev.source : null,
          blocks: {},
          blockOrder: [],
          stopReason: null,
          usage: null,
          task: emptySemanticTaskSnapshot(),
          lookups: emptySemanticLookupSnapshot(),
          startedAt: now,
          endedAt: null,
        }
      } else if (currentTurn.turnId !== turnId) {
        if (sessionKind === 'claude') {
          history = [...history, semanticHistoryRow(currentTurn)].slice(-SEMANTIC_HISTORY_CAP)
          currentTurn = {
            turnId,
            text: '',
            source: typeof ev.source === 'string' ? ev.source : null,
            blocks: {},
            blockOrder: [],
            stopReason: null,
            usage: null,
            task: emptySemanticTaskSnapshot(),
            lookups: emptySemanticLookupSnapshot(),
            startedAt: now,
            endedAt: null,
          }
        } else {
          break
        }
      }
      currentTurn = {
        ...currentTurn,
        text: typeof ev.fullText === 'string' ? ev.fullText : currentTurn.text,
        source: typeof ev.source === 'string' ? ev.source : currentTurn.source,
      }
      break
    }
    case 'block_started': {
      if (!currentTurn) break
      const idx = semanticToIndex(ev.blockIndex)
      if (idx === null) break
      // Codex emits `callId` where Claude emits `toolUseId`. Both feed
      // the same downstream tool-result pairing logic — populate
      // whichever the upstream sent, and mirror into the other so
      // existing consumers (e.g. the tool_result match in this file
      // at the toolUseId path) work regardless of source provider.
      const callId = typeof ev.callId === 'string' ? ev.callId : undefined
      const toolUseId = typeof ev.toolUseId === 'string' ? ev.toolUseId : callId
      const messagePhase =
        ev.messagePhase === 'commentary' || ev.messagePhase === 'final_answer'
          ? (ev.messagePhase as 'commentary' | 'final_answer')
          : undefined
      currentTurn = {
        ...currentTurn,
        blocks: {
          ...currentTurn.blocks,
          [idx]: {
            blockIndex: idx,
            kind: String(ev.kind ?? 'other'),
            toolName: typeof ev.toolName === 'string' ? ev.toolName : undefined,
            toolUseId,
            callId,
            itemId: typeof ev.itemId === 'string' ? ev.itemId : undefined,
            messagePhase,
            status: typeof ev.status === 'string' ? ev.status : undefined,
            text: '',
            thinking: '',
            inputJson: '',
          },
        },
        blockOrder: currentTurn.blockOrder.includes(idx)
          ? currentTurn.blockOrder
          : [...currentTurn.blockOrder, idx],
      }
      // Task/lookups derivation intentionally skipped here. The
      // trailing `finalCurrentTurn` computation at the bottom of
      // this reducer unconditionally re-derives from
      // `currentTurn.blocks`, so doing it inline would just be dead
      // work overwritten on the same event. The tool_result branch
      // DOES need its own inline derive because that branch can
      // push the turn to history and set currentTurn=null, skipping
      // the trailing computation.
      break
    }
    case 'text_delta': {
      if (!currentTurn) break
      const idx = semanticToIndex(ev.blockIndex)
      if (idx === null) break
      const block = currentTurn.blocks[idx]
      if (!block) break
      currentTurn = {
        ...currentTurn,
        blocks: {
          ...currentTurn.blocks,
          [idx]: {
            ...block,
            text:
              typeof ev.textSoFar === 'string'
                ? ev.textSoFar
                : (block.text ?? '') + String(ev.textDelta ?? ''),
          },
        },
      }
      break
    }
    case 'connector_text_delta': {
      if (!currentTurn) break
      const idx = semanticToIndex(ev.blockIndex)
      if (idx === null) break
      const block = currentTurn.blocks[idx]
      if (!block) break
      currentTurn = {
        ...currentTurn,
        blocks: {
          ...currentTurn.blocks,
          [idx]: {
            ...block,
            text:
              typeof ev.connectorTextSoFar === 'string'
                ? ev.connectorTextSoFar
                : (block.text ?? '') + String(ev.connectorTextDelta ?? ''),
          },
        },
      }
      break
    }
    case 'thinking_delta': {
      if (!currentTurn) break
      const idx = semanticToIndex(ev.blockIndex)
      if (idx === null) break
      const block = currentTurn.blocks[idx]
      if (!block) break
      currentTurn = {
        ...currentTurn,
        blocks: {
          ...currentTurn.blocks,
          [idx]: {
            ...block,
            thinking:
              typeof ev.thinkingSoFar === 'string'
                ? ev.thinkingSoFar
                : (block.thinking ?? '') + String(ev.thinkingDelta ?? ''),
          },
        },
      }
      break
    }
    case 'citations_delta': {
      if (!currentTurn) break
      const idx = semanticToIndex(ev.blockIndex)
      if (idx === null) break
      const block = currentTurn.blocks[idx]
      if (!block) break
      const citations = Array.isArray(ev.citationsSoFar)
        ? [...ev.citationsSoFar]
        : [...(block.citations ?? []), ev.citationsDelta]
      currentTurn = {
        ...currentTurn,
        blocks: {
          ...currentTurn.blocks,
          [idx]: {
            ...block,
            citations,
          },
        },
      }
      break
    }
    case 'signature': {
      if (!currentTurn) break
      const idx = semanticToIndex(ev.blockIndex)
      if (idx === null) break
      const block = currentTurn.blocks[idx]
      if (!block) break
      currentTurn = {
        ...currentTurn,
        blocks: {
          ...currentTurn.blocks,
          [idx]: {
            ...block,
            signature: typeof ev.signature === 'string' ? ev.signature : block.signature,
          },
        },
      }
      break
    }
    case 'tool_input_delta': {
      if (!currentTurn) break
      const idx = semanticToIndex(ev.blockIndex)
      if (idx === null) break
      const block = currentTurn.blocks[idx]
      if (!block) break
      currentTurn = {
        ...currentTurn,
        blocks: {
          ...currentTurn.blocks,
          [idx]: {
            ...block,
            inputJson:
              typeof ev.inputJsonSoFar === 'string'
                ? ev.inputJsonSoFar
                : (block.inputJson ?? '') + String(ev.partialJson ?? ''),
            toolName: block.toolName ?? (typeof ev.toolName === 'string' ? ev.toolName : undefined),
            toolUseId: block.toolUseId ?? (typeof ev.toolUseId === 'string' ? ev.toolUseId : undefined),
          },
        },
      }
      break
    }
    case 'tool_input_finalized': {
      if (!currentTurn) break
      const idx = semanticToIndex(ev.blockIndex)
      if (idx === null) break
      const block = currentTurn.blocks[idx]
      if (!block) break
      currentTurn = {
        ...currentTurn,
        blocks: {
          ...currentTurn.blocks,
          [idx]: {
            ...block,
            inputJson: typeof ev.inputJson === 'string' ? ev.inputJson : block.inputJson,
            inputJsonValid: Boolean(ev.parsed),
            parsedInput:
              ev.parsed && typeof ev.parsed === 'object'
                ? ev.parsed as Record<string, unknown>
                : block.parsedInput,
            parseError:
              typeof ev.parseError === 'string' ? ev.parseError : block.parseError,
            finalized: true,
          },
        },
      }
      break
    }
    case 'block_completed': {
      if (!currentTurn) break
      const idx = semanticToIndex(ev.blockIndex)
      if (idx === null) break
      const block = currentTurn.blocks[idx]
      if (!block) break
      // Codex sends typed fields for each ResponseItem variant; Claude
      // sends `parsed` for tool input. Merge both shapes here so the
      // renderer doesn't have to branch on provider. `parsed` (Claude)
      // and `parsedArguments` (Codex) populate the same `parsedInput`
      // slot; `inputJson` (Claude) and `argumentsJson` (Codex) populate
      // the same `inputJson` slot.
      const parsedObj =
        ev.parsed && typeof ev.parsed === 'object'
          ? (ev.parsed as Record<string, unknown>)
          : ev.parsedArguments && typeof ev.parsedArguments === 'object'
            ? (ev.parsedArguments as Record<string, unknown>)
            : block.parsedInput
      const argsRaw =
        typeof ev.inputJson === 'string'
          ? ev.inputJson
          : typeof ev.argumentsJson === 'string'
            ? ev.argumentsJson
            : block.inputJson
      const callId = typeof ev.callId === 'string' ? ev.callId : block.callId
      currentTurn = {
        ...currentTurn,
        blocks: {
          ...currentTurn.blocks,
          [idx]: {
            ...block,
            kind: typeof ev.kind === 'string' ? ev.kind : block.kind,
            text: typeof ev.text === 'string' ? ev.text : block.text,
            signature: typeof ev.signature === 'string' ? ev.signature : block.signature,
            toolName: typeof ev.toolName === 'string' ? ev.toolName : block.toolName,
            toolUseId:
              typeof ev.toolUseId === 'string'
                ? ev.toolUseId
                : (callId ?? block.toolUseId),
            callId,
            inputJson: argsRaw,
            argumentsJson:
              typeof ev.argumentsJson === 'string' ? ev.argumentsJson : block.argumentsJson,
            inputJsonValid:
              parsedObj === block.parsedInput ? block.inputJsonValid : Boolean(parsedObj),
            parsedInput: parsedObj,
            parseError:
              typeof ev.parseError === 'string' ? ev.parseError : block.parseError,
            status: typeof ev.status === 'string' ? ev.status : block.status,
            finalized: true,
            citations:
              ev.raw && typeof ev.raw === 'object' && Array.isArray((ev.raw as { citations?: unknown[] }).citations)
                ? [...((ev.raw as { citations: unknown[] }).citations)]
                : block.citations,
            // Codex-specific typed variant payloads. Forward as-is;
            // the renderer picks the right one based on `kind`.
            output: ev.output !== undefined ? ev.output : block.output,
            webSearchAction:
              ev.webSearchAction && typeof ev.webSearchAction === 'object'
                ? (ev.webSearchAction as SemanticLiveBlock['webSearchAction'])
                : block.webSearchAction,
            imageGeneration:
              ev.imageGeneration && typeof ev.imageGeneration === 'object'
                ? (ev.imageGeneration as SemanticLiveBlock['imageGeneration'])
                : block.imageGeneration,
            localShellCall:
              ev.localShellCall && typeof ev.localShellCall === 'object'
                ? (ev.localShellCall as SemanticLiveBlock['localShellCall'])
                : block.localShellCall,
            reasoningSummary:
              typeof ev.reasoningSummary === 'string'
                ? ev.reasoningSummary
                : block.reasoningSummary,
            reasoningText:
              typeof ev.reasoningText === 'string'
                ? ev.reasoningText
                : block.reasoningText,
          },
        },
      }
      break
    }
    case 'tool_result': {
      // WHY attach results onto the originating tool block instead of creating a
      // fresh pseudo-entry here:
      //
      // The semantic stream's job is to preserve the model's live structure. A
      // tool result is not a new assistant block; it is the resolution of a
      // previous tool_use. Storing it on the tool block keeps the renderer's
      // pairing logic trivial and avoids inventing extra ordering rules in the
      // store. If we later build a richer agent/task panel, it can still derive
      // timeline rows from this normalized shape.
      if (!currentTurn || typeof ev.toolUseId !== 'string') break
      if (typeof ev.turnId === 'string' && ev.turnId !== currentTurn.turnId) break
      const match = Object.entries(currentTurn.blocks).find(([, block]) => block.toolUseId === ev.toolUseId)
      if (!match) break
      const idx = Number(match[0])
      const block = match[1]
      currentTurn = {
        ...currentTurn,
        blocks: {
          ...currentTurn.blocks,
          [idx]: {
            ...block,
            resultContent: typeof ev.content === 'string' ? ev.content : block.resultContent,
            resultIsError: ev.isError === true,
            resultAt: now,
          },
        },
      }
      {
        const derived = deriveSemanticTaskSnapshot(currentTurn.blocks)
        const nextTurn = {
          ...currentTurn,
          task: derived.task,
          lookups: derived.lookups,
        }
        if (nextTurn.endedAt != null && !hasPendingSemanticTools(nextTurn)) {
          history = [
            ...history,
            semanticHistoryRow(nextTurn),
          ].slice(-SEMANTIC_HISTORY_CAP)
          currentTurn = null
        } else {
          currentTurn = nextTurn
        }
      }
      break
    }
    case 'tool_started': {
      const callId = typeof ev.callId === 'string' ? ev.callId : null
      if (!callId) break
      const turnId =
        typeof ev.turnId === 'string'
          ? ev.turnId
          : currentTurn?.turnId ?? `codex-${now}`
      // Provider-gated turn ownership (see turn_started for full
      // rationale). Codex drops on mismatch (flicker defense);
      // Claude archives and replaces (self-heals the stuck-pending-tool
      // case). tool_started is Codex-only in practice today, but
      // gating by provider keeps the policy consistent with the other
      // two branches and avoids a subtle divergence for future
      // Claude-side emitters.
      if (!currentTurn) {
        currentTurn = {
          turnId,
          text: '',
          source: typeof ev.source === 'string' ? ev.source : null,
          blocks: {},
          blockOrder: [],
          stopReason: null,
          usage: null,
          task: emptySemanticTaskSnapshot(),
          lookups: emptySemanticLookupSnapshot(),
          startedAt: now,
          endedAt: null,
        }
      } else if (currentTurn.turnId !== turnId) {
        if (sessionKind === 'claude') {
          history = [...history, semanticHistoryRow(currentTurn)].slice(-SEMANTIC_HISTORY_CAP)
          currentTurn = {
            turnId,
            text: '',
            source: typeof ev.source === 'string' ? ev.source : null,
            blocks: {},
            blockOrder: [],
            stopReason: null,
            usage: null,
            task: emptySemanticTaskSnapshot(),
            lookups: emptySemanticLookupSnapshot(),
            startedAt: now,
            endedAt: null,
          }
        } else {
          break
        }
      }
      const existing = Object.values(currentTurn.blocks).find(block => block.toolUseId === callId)
      if (existing) break
      const numericIndices = Object.keys(currentTurn.blocks)
        .map(value => Number(value))
        .filter(value => Number.isFinite(value))
      const nextIndex =
        numericIndices.length > 0 ? Math.max(...numericIndices) + 1 : 0
      const label = typeof ev.label === 'string' ? ev.label : ''
      const toolKind = ev.tool === 'mcp' ? 'mcp_tool_use' : 'tool_use'
      const toolName =
        ev.tool === 'exec'
          ? 'exec_command'
          : ev.tool === 'mcp'
            ? label || 'mcp'
            : label || (typeof ev.tool === 'string' ? ev.tool : 'tool')
      currentTurn = {
        ...currentTurn,
        source: typeof ev.source === 'string' ? ev.source : currentTurn.source,
        blocks: {
          ...currentTurn.blocks,
          [nextIndex]: {
            blockIndex: nextIndex,
            kind: toolKind,
            toolName,
            toolUseId: callId,
            text: '',
            thinking: '',
            inputJson: label,
          },
        },
        blockOrder: [...currentTurn.blockOrder, nextIndex],
      }
      break
    }
    case 'tool_output_delta': {
      if (!currentTurn) break
      const callId = typeof ev.callId === 'string' ? ev.callId : null
      if (!callId) break
      const match = Object.entries(currentTurn.blocks).find(([, block]) => block.toolUseId === callId)
      if (!match) break
      const idx = Number(match[0])
      const block = match[1]
      currentTurn = {
        ...currentTurn,
        blocks: {
          ...currentTurn.blocks,
          [idx]: {
            ...block,
            resultContent:
              typeof ev.textDelta === 'string'
                ? (block.resultContent ?? '') + ev.textDelta
                : block.resultContent,
          },
        },
      }
      break
    }
    case 'tool_completed': {
      if (!currentTurn) break
      const callId = typeof ev.callId === 'string' ? ev.callId : null
      if (!callId) break
      const match = Object.entries(currentTurn.blocks).find(([, block]) => block.toolUseId === callId)
      if (!match) break
      const idx = Number(match[0])
      const block = match[1]
      currentTurn = {
        ...currentTurn,
        blocks: {
          ...currentTurn.blocks,
          [idx]: {
            ...block,
            resultContent: block.resultContent ?? '',
            resultIsError:
              typeof ev.exitCode === 'number' ? ev.exitCode !== 0 : block.resultIsError,
            resultAt: now,
          },
        },
      }
      break
    }
    case 'usage_updated': {
      if (!currentTurn) break
      const usage = ev.usage as Record<string, unknown> | undefined
      if (!usage) break
      currentTurn = { ...currentTurn, usage: flattenSemanticUsage(usage) }
      break
    }
    case 'turn_stopped': {
      if (!currentTurn) break
      currentTurn = {
        ...currentTurn,
        stopReason: typeof ev.stopReason === 'string' ? ev.stopReason : null,
        endedAt: now,
      }
      break
    }
    case 'turn_completed': {
      if (!currentTurn) break
      const completedTurn = { ...currentTurn, endedAt: currentTurn.endedAt ?? now }
      if (hasPendingSemanticTools(completedTurn)) {
        currentTurn = completedTurn
      } else {
        history = [
          ...history,
          semanticHistoryRow(completedTurn),
        ].slice(-SEMANTIC_HISTORY_CAP)
        currentTurn = null
      }
      break
    }
    case 'api_error':
    case 'stream_error': {
      errors = [
        ...errors,
        {
          ts: now,
          kind: t,
          message: String(ev.message ?? '(no message)'),
        },
      ].slice(-SEMANTIC_ERROR_CAP)
      break
    }
  }

  // WHY the trailing derive is conditional on event type:
  //   `deriveSemanticTaskSnapshot` is O(n_blocks) and rebuilds
  //   `toolCallsById` from scratch. At streaming peak we get many
  //   text_delta / thinking_delta / signature events per second that
  //   ONLY mutate fields the derivation doesn't read (block.text,
  //   block.thinking, block.signature). Running the derive on those
  //   events is pure waste. Events in the allow-list below are the
  //   only ones that can change what derive sees — block lifecycle,
  //   tool input (goes into inputJson), finalized parse (TodoWrite
  //   parsedInput), or completed `turn_completed` where the result
  //   is pushed to history even if currentTurn survives this tick.
  //
  //   block_started and tool_result already derive inline, so for
  //   them the trailing run is a second computation — intentional
  //   here, because their inline branch leaves currentTurn with the
  //   derived values and the trailing run is a cheap no-op pass that
  //   keeps this block the single place responsible for derived
  //   fields when currentTurn remains live.
  //
  //   Codex also emits `tool_started` / `tool_output_delta` /
  //   `tool_completed` (non-Anthropic tool lifecycle — see the
  //   `tool_started` / `tool_completed` branches above, which synthesize
  //   tool_use blocks and stamp resultAt / resultIsError). Those MUST be
  //   in this allow-list: without them `deriveSemanticTaskSnapshot`
  //   never sees a new block entering `in_progress`, never sees it
  //   transition to `completed`/`error`, and `lookups.toolCallsById`,
  //   `lookups.resolvedToolUseIds`, `task.activeToolNames`, and
  //   `task.inProgressToolUseIds` go stale until some Anthropic-style
  //   event happens to retrigger derive. The user-visible symptom was
  //   Codex tool rows stuck showing "running" forever after completion.
  const DERIVE_EVENT_TYPES = new Set([
    'block_started',
    'tool_input_delta',
    'tool_input_finalized',
    'tool_result',
    'tool_started',
    'tool_output_delta',
    'tool_completed',
  ])
  const finalCurrentTurn = currentTurn
    ? DERIVE_EVENT_TYPES.has(t)
      ? (() => {
          const derived = deriveSemanticTaskSnapshot(currentTurn.blocks)
          return {
            ...currentTurn,
            task: derived.task,
            lookups: derived.lookups,
          }
        })()
      : currentTurn
    : null

  return {
    ...state,
    flows,
    currentTurn: finalCurrentTurn,
    history,
    errors,
    log,
    nextLogId: state.nextLogId + 1,
  }
}

function codexConversationEntryFromMessageItem(
  uuid: string,
  timestamp: string | undefined,
  payload: Record<string, unknown>,
): Entry | null {
  if (
    payload.type !== 'message' ||
    (payload.role !== 'user' && payload.role !== 'assistant')
  ) {
    return null
  }

  const role = payload.role
  const content = Array.isArray(payload.content)
    ? payload.content
        .map(block => {
          const item = block as Record<string, unknown>
          const text = typeof item.text === 'string' ? item.text : null
          if (!text) return null
          if (item.type === 'input_text' || item.type === 'output_text') {
            return { type: 'text' as const, text }
          }
          return null
        })
        .filter((block): block is { type: 'text'; text: string } => block !== null)
    : []

  if (content.length === 0) return null
  return {
    type: role,
    uuid,
    parentUuid: null,
    timestamp,
    message: { role, content },
  }
}

function codexCompactBoundaryEntry(
  uuid: string,
  payload: Record<string, unknown>,
): Entry {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    uuid,
    compactMetadata: payload,
  }
}

function codexCompactSummaryEntry(
  uuid: string,
  timestamp: string | undefined,
  text: string,
): Entry {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    timestamp,
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  }
}

/**
 * Extract the Codex rollout's per-turn response id from a
 * `turn_context` side-channel entry. Returns null for any other
 * entry type. Call sites that iterate a rollout stream use this to
 * keep a rolling "current turn id" that subsequent `response_item`
 * entries get stamped with via `stampCodexTurnId`.
 *
 * WHY: Codex rollout doesn't put `turn_id` on per-item entries —
 * only on `task_started`/`turn_started` and `turn_context`. Without
 * tracking it here the ghost reconciler in `reconcileUpstream` has
 * nothing to match Codex assistant-text ghosts against (they don't
 * carry `message.id`, don't carry `tool_use_id`).
 */
export function codexTurnIdFromRollout(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'turn_context') return null
  const payload = entry.payload as Record<string, unknown> | undefined
  return typeof payload?.turn_id === 'string' ? (payload.turn_id as string) : null
}

/**
 * Stamp a mapped Codex feed entry with the rollout turn id so the
 * ghost reconciler can supersede by turn id. The field is added as
 * a cc-shell-local extension to the shared `Entry` type via cast —
 * consumers that don't care about it ignore it, and
 * `reconcileUpstream` reads it defensively.
 */
function stampCodexTurnId(entry: Entry, turnId: string | null): Entry {
  if (turnId === null) return entry
  return { ...entry, codexTurnId: turnId } as Entry
}

export function mapCodexRolloutToFeedEntries(entry: Record<string, unknown>): Entry[] {
  const uuid =
    `${String(entry.timestamp ?? Date.now())}:${String((entry.payload as Record<string, unknown> | undefined)?.id ?? (entry.payload as Record<string, unknown> | undefined)?.call_id ?? (entry.payload as Record<string, unknown> | undefined)?.type ?? entry.type)}`
  const timestamp =
    typeof entry.timestamp === 'string' ? entry.timestamp : undefined

  const payload = entry.payload as Record<string, unknown> | undefined
  if (!payload || typeof payload.type !== 'string') return []

  if (entry.type === 'event_msg') {
    const atp = entry._atp as { origin?: string; source?: Record<string, unknown> } | undefined
    if (
      payload.type === 'user_message' &&
      atp?.origin === 'claude' &&
      atp.source?.isCompactSummary === true
    ) {
      const sourceMessage = atp.source.message as { content?: unknown } | undefined
      const sourceText =
        typeof sourceMessage?.content === 'string'
          ? sourceMessage.content
          : typeof payload.message === 'string'
            ? payload.message
            : ''
      return sourceText
        ? [codexCompactSummaryEntry(`${uuid}:compact-summary`, timestamp, sourceText)]
        : []
    }

    if (payload.type === 'exec_approval_request') {
      const command = Array.isArray(payload.command)
        ? payload.command.filter((part): part is string => typeof part === 'string')
        : []
      const workdir = typeof payload.workdir === 'string' ? payload.workdir : null
      const summary = [
        'Permission required before Codex can run a command.',
        command.length > 0 ? `Command: ${command.join(' ')}` : null,
        workdir ? `Directory: ${workdir}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join('\n')
      return summary ? [codexAssistantTextEntry(uuid, timestamp, summary)] : []
    }

    if (
      payload.type === 'exec_command_end' &&
      typeof payload.call_id === 'string'
    ) {
      const output = String(
        payload.aggregated_output ??
        payload.formatted_output ??
        payload.stdout ??
        payload.stderr ??
        '',
      )
      const exitCode =
        typeof payload.exit_code === 'number' ? payload.exit_code : 0
      if (!output.trim() && exitCode === 0) return []
      return [
        codexToolResultEntry(
          uuid,
          timestamp,
          payload.call_id,
          output,
          exitCode !== 0 || payload.status === 'failed',
          {
            kind: 'exec_command_end',
            parsedCmd: Array.isArray(payload.parsed_cmd) ? payload.parsed_cmd : [],
            command: Array.isArray(payload.command) ? payload.command : [],
            cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
            exitCode,
          },
        ),
      ]
    }

    if (
      payload.type === 'patch_apply_end' &&
      typeof payload.call_id === 'string'
    ) {
      const stdout = typeof payload.stdout === 'string' ? payload.stdout : ''
      const stderr = typeof payload.stderr === 'string' ? payload.stderr : ''
      const content = stdout || stderr
      return [
        codexToolResultEntry(
          uuid,
          timestamp,
          payload.call_id,
          content,
          payload.success !== true,
          {
            kind: 'patch_apply_end',
            success: payload.success === true,
            changes: payload.changes && typeof payload.changes === 'object'
              ? payload.changes as Record<string, unknown>
              : {},
          },
        ),
      ]
    }

    return []
  }

  if (entry.type === 'compacted') {
    const out: Entry[] = [
      codexCompactBoundaryEntry(`${uuid}:compact-boundary`, payload),
    ]

    const message = typeof payload.message === 'string' ? payload.message.trim() : ''
    if (message) {
      out.push(codexCompactSummaryEntry(`${uuid}:compact-summary`, timestamp, message))
    }

    const replacementHistory = Array.isArray(payload.replacement_history)
      ? payload.replacement_history
      : []
    for (let i = 0; i < replacementHistory.length; i += 1) {
      const item = replacementHistory[i] as Record<string, unknown>
      const mapped = codexConversationEntryFromMessageItem(
        `${uuid}:replacement:${i}`,
        timestamp,
        item,
      )
      if (mapped) out.push(mapped)
    }

    return out
  }

  if (entry.type !== 'response_item') return []

  const conversationEntry = codexConversationEntryFromMessageItem(uuid, timestamp, payload)
  if (conversationEntry) return [conversationEntry]

  if (
    payload.type === 'custom_tool_call' &&
    typeof payload.call_id === 'string' &&
    typeof payload.name === 'string'
  ) {
    const input =
      typeof payload.input === 'string'
        ? parseCodexJson(payload.input) ?? { raw: payload.input }
        : { raw: '' }
    return [codexToolUseEntry(uuid, timestamp, payload.call_id, payload.name, input)]
  }

  if (
    payload.type === 'function_call' &&
    typeof payload.call_id === 'string' &&
    typeof payload.name === 'string'
  ) {
    const input =
      typeof payload.arguments === 'string'
        ? parseCodexJson(payload.arguments) ?? { arguments: payload.arguments }
        : { arguments: payload.arguments }
    return [codexToolUseEntry(uuid, timestamp, payload.call_id, payload.name, input)]
  }

  if (payload.type === 'function_call_output' && typeof payload.call_id === 'string') {
    const output = stripCodexExecWrapper(codexOutputText(payload.output))
    if (!output.trim() || isCodexExecWrapperOutput(codexOutputText(payload.output))) {
      return []
    }
    return [codexToolResultEntry(uuid, timestamp, payload.call_id, output)]
  }

  if (payload.type === 'custom_tool_call_output' && typeof payload.call_id === 'string') {
    const output = codexOutputText(payload.output)
    const parsed = parseCodexJson(output)
    const normalized =
      typeof parsed?.output === 'string' ? parsed.output : output
    const metadata = parsed?.metadata
    const exitCode =
      metadata && typeof metadata === 'object' && typeof (metadata as Record<string, unknown>).exit_code === 'number'
        ? (metadata as Record<string, unknown>).exit_code as number
        : 0
    if (
      typeof normalized === 'string' &&
      normalized.startsWith('Success. Updated the following files:')
    ) {
      return []
    }
    return [
      codexToolResultEntry(
        uuid,
        timestamp,
        payload.call_id,
        normalized,
        exitCode !== 0,
        { kind: 'custom_tool_call_output' },
      ),
    ]
  }

  return []
}

export function codexHistoryMarker(entry: Record<string, unknown>): string {
  const payload = entry.payload as Record<string, unknown> | undefined
  return `${String(entry.timestamp ?? '')}:${String(payload?.id ?? payload?.call_id ?? payload?.type ?? entry.type)}`
}

// Mutates `toolUseIndex` and `toolResultIndex` in place, folding one
// feed entry's tool_use / tool_result blocks into the per-session
// lookup maps. Used by both the bulk jsonl-entries ingest path and
// the singular one — keeps the indexing logic in one place so Feed
// never has to rebuild these maps in a useMemo.
//
// WHY in-place mutation of a map stored on runtime state:
//   The map reference doesn't change, only its contents — Feed reads
//   through context and treats the map as a live lookup rather than
//   a diffable prop. React.memo of downstream rows is unaffected
//   (they don't depend on the map's reference identity), and we
//   avoid allocating a new Map per entry during a bootstrap burst.
function indexEntryIntoMaps(
  entry: Entry,
  toolUseIndex: Map<string, ToolUseBlock>,
  toolResultIndex: Map<string, ToolResultBlock>,
): void {
  if (!isConversationEntry(entry)) return
  const content = entry.message.content
  if (!Array.isArray(content)) return
  for (const b of content) {
    if (b.type === 'tool_use') {
      const tu = b as ToolUseBlock
      toolUseIndex.set(tu.id, tu)
    } else if (b.type === 'tool_result') {
      const tr = b as ToolResultBlock
      toolResultIndex.set(tr.tool_use_id, tr)
    }
  }
}

export function claudeHistoryMarker(entry: Record<string, unknown>): string | null {
  const embedded = extractEmbeddedClaudeProgressEntry(entry)
  if (embedded?.uuid) return embedded.uuid
  return typeof entry.uuid === 'string' ? entry.uuid : null
}

export function extractEmbeddedClaudeProgressEntry(
  entry: Record<string, unknown>,
): ConversationEntry | null {
  if (entry.type !== 'progress') return null
  const data = entry.data as Record<string, unknown> | undefined
  const embedded = data?.message as Record<string, unknown> | undefined
  if (!embedded) return null

  const type = embedded.type
  if (type !== 'assistant' && type !== 'user') return null
  if (!embedded.message || typeof embedded.message !== 'object') return null

  return {
    type,
    uuid:
      typeof embedded.uuid === 'string'
        ? embedded.uuid
        : `${String(entry.timestamp ?? Date.now())}:progress:${type}`,
    parentUuid:
      typeof embedded.parentUuid === 'string' ? embedded.parentUuid : null,
    timestamp:
      typeof embedded.timestamp === 'string'
        ? embedded.timestamp
        : typeof entry.timestamp === 'string'
          ? entry.timestamp
          : undefined,
    sessionId:
      typeof embedded.sessionId === 'string'
        ? embedded.sessionId
        : typeof entry.sessionId === 'string'
          ? entry.sessionId
          : undefined,
    gitBranch:
      typeof embedded.gitBranch === 'string'
        ? embedded.gitBranch
        : typeof entry.gitBranch === 'string'
          ? entry.gitBranch
          : undefined,
    cwd:
      typeof embedded.cwd === 'string'
        ? embedded.cwd
        : typeof entry.cwd === 'string'
          ? entry.cwd
          : undefined,
    isSidechain: embedded.isSidechain === true,
    message: embedded.message as ConversationEntry['message'],
  }
}

// ---------------------------------------------------------------------------
// Persisted state shape (serialized to ~/.config/cc-shell/workspace.json)
// ---------------------------------------------------------------------------

/**
 * Persisted workspace shape. Live runtime state is NOT here — we
 * respawn sessions on load and their state rebuilds naturally from
 * fresh IPC events.
 */
type PersistedWorkspace = {
  // Tab tree with sessionIds that refer to the CURRENT launch's
  // sessions. On load we re-spawn and remap ids, so persisted ids are
  // just placeholders that get replaced.
  tabs: Array<{
    id: TabId
    title: string
    focusedSessionId: SessionId
    root: TileNode
  }>
  activeTabId: TabId
  sessions: Record<SessionId, SessionMeta>
  buried?: BuriedPaneRecord[]
  tileTabs?: TileTabsState | null
  /** Draft input text per session, keyed by sessionId. Persisted so
   *  in-progress prompts survive app crashes and restarts. Only
   *  non-empty drafts are saved to keep the file small. */
  drafts?: Record<SessionId, string>
}

// ---------------------------------------------------------------------------
// The store hook
// ---------------------------------------------------------------------------

export type Workspace = ReturnType<typeof useWorkspace>

export function useWorkspace(
  dangerousAgentsEnabled = false,
  useProxyStreaming = false,
) {
  // GlobalToast lives one level up in the provider tree (mounted in
  // main.tsx). Reading it here lets close actions surface a brief
  // "Closed — ⌘⇧T (Undo Close)" hint without each caller having to know
  // about the toast system. The hook returns a stable callback so
  // re-renders don't churn close handlers.
  const { showToast } = useGlobalToast()
  const openBuryPrompt = useAppStore(store => store.openBuryPrompt)
  const closeBuryPrompt = useAppStore(store => store.closeBuryPrompt)
  const openNewAgentPlacement = useAppStore(store => store.openNewAgentPlacement)
  const closeNewAgentPlacement = useAppStore(store => store.closeNewAgentPlacement)

  const state = useAppStore(store => store.workspaceState)
  const setState = useAppStore(store => store.setWorkspaceState)

  // Ref mirror of state so IPC callbacks (which close over stale state)
  // can read the current session metadata (e.g. kind) without causing
  // re-subscriptions on every state change.
  const stateRef = useRef(state)
  stateRef.current = state
  const dangerousAgentsRef = useRef(dangerousAgentsEnabled)
  dangerousAgentsRef.current = dangerousAgentsEnabled
  // Ref-mirrored so the spawn callbacks below read the live value
  // without having to subscribe per-call (same pattern as
  // dangerousAgentsRef above).
  const useProxyStreamingRef = useRef(useProxyStreaming)
  useProxyStreamingRef.current = useProxyStreaming

  // Per-session runtime state. Keyed by sessionId. NOT part of
  // persistent state — runtime rebuilds from IPC events after respawn.
  const runtimes = useAppStore(store => store.workspaceRuntimes)
  const setRuntimes = useAppStore(store => store.setWorkspaceRuntimes)
  const spotlight = useAppStore(store => store.workspaceSpotlight)
  const setSpotlight = useAppStore(store => store.setWorkspaceSpotlight)
  const tileTabs = useAppStore(store => store.workspaceTileTabs)
  const setTileTabs = useAppStore(store => store.setWorkspaceTileTabs)
  const latestTileTabsRef = useRef(tileTabs)
  latestTileTabsRef.current = tileTabs
  const readerMode = useAppStore(store => store.workspaceReaderMode)
  const setReaderMode = useAppStore(store => store.setWorkspaceReaderMode)

  // Ref mirror of runtimes so the debounced save callback can read
  // current drafts without re-creating the callback on every render.
  const latestRuntimesRef = useRef(runtimes)
  latestRuntimesRef.current = runtimes
  const persistedFeedDebugIdRef = useRef<Record<SessionId, number>>({})

  // Seen uuids per session, for JSONL dedup. Refs because we never
  // render against them — they're bookkeeping.
  const seenUuidsRef = useRef<Record<SessionId, Set<string>>>({})

  // Latest screen per session — mirrored from state into a ref so the
  // Enter handler in TileLeaf can capture a baseline synchronously.
  const latestScreenRef = useRef<Record<SessionId, string>>({})

  // Undo-close stack — mutable ref because the stack is imperative
  // (push/pop) and we don't want React re-renders on every close.
  // The undoClose action reads it and the command palette peeks at
  // .length to show/hide the command.
  const undoStackRef = useRef(new UndoCloseStack())

  // Per-session setTimeout ids used to debounce the `bootstrapping`
  // flag back to false after a bulk jsonl-entries burst. Keyed by
  // sessionId; cleared in the IPC-effect cleanup and in killSession.
  // Ref (not state) because the timer handle is irrelevant to
  // rendering — we just need it alive across the hook's ticks.
  const bootstrapTimersRef = useRef<Map<SessionId, ReturnType<typeof setTimeout>>>(new Map())

  // ---- Helpers ----

  const updateRuntime = useCallback(
    (sessionId: SessionId, patch: Partial<SessionRuntime>) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        return {
          ...prev,
          [sessionId]: withDerivedSessionStatus({ ...current, ...patch }),
        }
      })
    },
    [],
  )

  const appendFeedDebug = useCallback(
    (sessionId: SessionId, input: FeedDebugInput) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const next = appendFeedDebugLog(current, input)
        if (next === current) return prev
        return {
          ...prev,
          [sessionId]: next,
        }
      })
    },
    [],
  )

  const getRuntime = useCallback(
    (sessionId: SessionId): SessionRuntime => {
      return runtimes[sessionId] ?? emptyRuntime()
    },
    [runtimes],
  )

  const toggleTailMode = useCallback((sessionId: SessionId) => {
    setRuntimes(prev => {
      const current = prev[sessionId] ?? emptyRuntime()
      return {
        ...prev,
        [sessionId]: {
          ...current,
          tailMode: !current.tailMode,
        },
      }
    })
  }, [])

  const scrollFocusedToLatest = useCallback(() => {
    const snap = stateRef.current
    const tab = snap.tabs.find(t => t.id === snap.activeTabId)
    const sessionId = tab?.focusedSessionId
    if (!sessionId) return
    setRuntimes(prev => {
      const current = prev[sessionId] ?? emptyRuntime()
      return {
        ...prev,
        [sessionId]: {
          ...current,
          scrollToLatestRequest: current.scrollToLatestRequest + 1,
        },
      }
    })
  }, [])

  // ---- IPC subscription: dispatch all session events to the right runtime ----
  //
  // One listener per event type. The callback looks up the session by
  // sessionId from the payload and patches the corresponding runtime.
  useEffect(() => {
    const offStarted = window.api.onSessionStarted(({ sessionId, projectDir }) => {
      updateRuntime(sessionId, { projectDir })
      appendFeedDebug(sessionId, {
        layer: 'STATE',
        kind: 'session_started',
        summary: `session started${projectDir ? ` · ${projectDir}` : ''}`,
        data: { projectDir },
      })
    })

    const offScreen = window.api.onSessionScreen(
      ({ sessionId, plain, markdown, recent, recentMarkdown, picker }) => {
        // latestScreenRef is the synchronous source of truth for the
        // Enter-baseline capture in TileLeaf — always update it, even
        // when we bail on React state below.
        // Use `recent` (wider window) so the baseline includes any
        // assistant text that may have already scrolled out of the
        // viewport. The baseline comparison is the basis for "is the
        // streaming card stale?", which depends on seeing the same
        // marker the streaming extractor will see.
        latestScreenRef.current[sessionId] = recent

        setRuntimes(prev => {
          const current = prev[sessionId] ?? emptyRuntime()
          // Screen snapshots fire continuously (CC redraws its TUI at
          // ~60Hz) but the actual text is usually identical between
          // frames — CC is redrawing chrome, cursor, or a spinner that
          // our parser already strips. Without a bail-out, every idle
          // frame triggers a new `runtimes` state → useWorkspace
          // re-render → TileTree/TileLeaf reconcile → Feed.memo check
          // (which does then skip, but reconciliation to that point
          // isn't free). Comparing strings by reference first, then by
          // value, and bailing before setState entirely saves that
          // whole pass on every no-op frame. This is the difference
          // between "scheduled work on every frame" and "scheduled work
          // only when the screen actually changed".
          if (
            current.screen === plain &&
            current.screenMarkdown === markdown &&
            current.recentScreen === recent &&
            current.recentScreenMarkdown === recentMarkdown &&
            pickerEqual(current.picker, picker)
          ) {
            return prev
          }
          const changed: string[] = []
          if (current.screen !== plain) changed.push('screen')
          if (current.recentScreen !== recent) changed.push('recent')
          if (current.screenMarkdown !== markdown) changed.push('markdown')
          if (!pickerEqual(current.picker, picker)) changed.push('picker')
          // Detect Codex approval overlay from the screen. Only runs
          // for codex sessions — Claude has its own trust dialog path.
          //
          // Two sources feed `pendingApproval`:
          //   1. JSONL `exec_approval_request` — authoritative for
          //      `callId` / `command` / `workdir`. The callId is what
          //      we match against `exec_command_end` to dismiss.
          //   2. Screen scrape — authoritative for the dynamic UI bits
          //      the user actually sees (`reason`, `options`,
          //      `selectedIndex`) since arrow-key nav only updates the
          //      TUI, never the JSONL.
          //
          // Originally this handler clobbered the JSONL fields with
          // `callId: null`, which broke dismissal: when
          // `exec_command_end` arrived later, the comparison
          // `current.pendingApproval?.callId === resolvedCallId` saw
          // `null === "real-id"` and the modal stuck forever. Now we
          // MERGE — JSONL fields survive screen frames; screen fields
          // overwrite their counterparts on every frame.
          //
          // When the screen shows no overlay we PRESERVE a JSONL-sourced
          // approval (callId !== null) — the rule is "JSONL opens it,
          // JSONL closes it". A screen-only approval (callId === null)
          // can be cleared by a stale frame because there's no JSONL
          // dismissal event coming.
          const sessionKind = stateRef.current.sessions[sessionId]?.kind
          const screenApproval = sessionKind === 'codex'
            ? detectCodexApproval(plain)
            : null
          const nextApproval = screenApproval
            ? current.pendingApproval?.callId
              ? {
                  ...current.pendingApproval,
                  reason: screenApproval.reason,
                  options: screenApproval.options,
                  selectedIndex: screenApproval.selectedIndex,
                }
              : {
                  callId: null,
                  command: screenApproval.command
                    ? screenApproval.command.split(/\s+/)
                    : [],
                  workdir: null,
                  reason: screenApproval.reason,
                  options: screenApproval.options,
                  selectedIndex: screenApproval.selectedIndex,
                }
            : current.pendingApproval?.callId
              ? current.pendingApproval
              : null

          const nextCurrent = appendFeedDebugLog(
            {
              ...current,
              screen: plain,
              screenMarkdown: markdown,
              recentScreen: recent,
              recentScreenMarkdown: recentMarkdown,
              picker,
              // activityStatus is owned by the process-state IPC handler
              // below — it carries the provider-correct verb (Claude's
              // spinner verb, Codex's bottom-row text). Recomputing it
              // here from `detectActivity(plain)` was Claude-specific
              // and would overwrite Codex's status with null on every
              // frame, racing the process-state writer.
              pendingApproval: nextApproval,
            },
            {
              layer: 'STATE',
              kind: 'screen_update',
              summary: `screen update · ${changed.join(', ')}`,
              data: {
                changed,
                pickerVisible: picker.visible,
                pickerCount: picker.items.length,
                approvalOpen: nextApproval !== null,
                recentLength: recent.length,
              },
            },
          )
          return {
            ...prev,
            [sessionId]: nextCurrent,
          }
        })
      },
    )

    // The singular session:jsonl-entry IPC handler used to live here.
    // It owned: codex providerSessionId capture, codex approval
    // request/resolve, claude queue-operation bookkeeping, claude
    // providerSessionId capture, pendingCompaction clearing, and the
    // entry append itself.
    //
    // It caused the bootstrap-replay cascade. On a resume Claude /
    // Codex emits ~200 jsonl-entry events synchronously; main used to
    // dual-emit those as 200 separate session:jsonl-entry IPC sends
    // PLUS one coalesced session:jsonl-entries burst. The 200 singular
    // messages always reached the renderer first (they were enqueued
    // first), and the singular handler did 200 separate setRuntimes
    // calls — one full re-render per entry, plus the auto-scroll pin
    // and lazy-mount cascade per entry. By the time the bulk message
    // arrived, every uuid was already in seenUuidsRef and the bulk
    // path no-op'd — the bootstrapping flag never asserted.
    //
    // The fix: drop the singular IPC emit on main entirely (see
    // wireManagerIPC); make the bulk handler below own every
    // side-effect that used to live here. Live single entries arrive
    // as 1-element bursts with ~1ms setImmediate latency.
    //
    // If you need to re-introduce a single-entry consumer, route it
    // through the bulk channel as a 1-element burst. Do NOT add a
    // second IPC channel that races the bulk one.

    const offErr = window.api.onSessionJsonlError(({ sessionId, message }) => {
      // eslint-disable-next-line no-console
      console.warn(`[jsonl ${sessionId.slice(0, 8)}]`, message)
    })

    const offExit = window.api.onSessionExit(({ sessionId, exitCode }) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const next = withDerivedSessionStatus(
          appendFeedDebugLog(
            {
              ...current,
              exited: exitCode,
              awaitingAssistant: false,
              queuedMessages: [],
              activityStatus: null,
              processActive: false,
              // Clear phase on exit. The WorkIndicator renders nothing for
              // `idle`; letting a pre-exit phase linger would leave the
              // in-feed indicator saying e.g. "Awaiting Bash" on a dead
              // session. Matching the existing activityStatus null.
              streamPhase: 'idle',
              streamPhasePendingToolName: null,
              streamPhasePendingToolUseId: null,
              turnStartedAt: null,
              phaseChangedAt: null,
              submittedAt: null,
              semantic: {
                ...current.semantic,
                currentTurn: null,
              },
            },
            {
              layer: 'STATE',
              kind: 'session_exit',
              summary: `session exited code=${exitCode}`,
              data: { exitCode },
            },
          ),
        )
        return { ...prev, [sessionId]: next }
      })
    })

    // Provider-emitted activity state. Both providers now derive this
    // from their own screen spinner detector — Claude's rotating-glyph
    // line, Codex's bottom "Working (...)" row — and forward the
    // verb/status string alongside the boolean. When status arrives
    // we adopt it directly; the renderer used to redundantly run
    // Claude's detectActivity on every screen frame to derive the
    // verb, which was both wasteful and wrong for Codex (the parser
    // is Claude-specific). On idle transitions, status is undefined
    // and we clear activityStatus too.
    const offProcessState = window.api.onSessionProcessState(({ sessionId, active, status }) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const next = withDerivedSessionStatus(
          appendFeedDebugLog(
            {
              ...current,
              processActive: active,
              activityStatus: active ? (status ?? null) : null,
              awaitingAssistant: false,
            },
            {
              layer: 'STATE',
              kind: 'process_state',
              summary: active
                ? `process active${status ? ` · ${status}` : ''}`
                : 'process idle',
              data: { active, status: status ?? null },
            },
          ),
        )
        return { ...prev, [sessionId]: next }
      })
    })

    const offSemantic = window.api.onSessionSemanticEvent(({ sessionId, event }) => {
      const semanticEvent = event as Record<string, unknown>
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        // WHY `?? 'claude'` default: Claude is the pre-fix behavior
        // (auto-replace / self-heal on turnId mismatch). Falling back to
        // the looser behavior during a teardown-race where the session
        // meta is momentarily absent avoids silently dropping events
        // we'd actually want to keep. See
        // docs/superpowers/plans/2026-04-17-claude-semantic-provider-gating.md.
        const sessionKind = stateRef.current.sessions[sessionId]?.kind ?? 'claude'
        const nextSemantic = foldSemanticEvent(current.semantic, semanticEvent, sessionKind)
        const eventType = typeof semanticEvent.type === 'string' ? semanticEvent.type : ''
        const clearOptimisticAwaiting =
          isSemanticTurnRunning(nextSemantic.currentTurn) ||
          eventType === 'turn_completed' ||
          eventType === 'turn_stopped' ||
          eventType === 'api_error' ||
          eventType === 'stream_error'

        // stream_phase — in-feed indicator state. Overrides the
        // optimistic `submitting` pseudo-phase once the adapter's
        // first real event lands. Handled inline here (not inside
        // foldSemanticEvent) because the field lives on SessionRuntime,
        // not SemanticRuntimeState; the fold would be a layering
        // violation.
        let streamPhase = current.streamPhase
        let streamPhasePendingToolName = current.streamPhasePendingToolName
        let streamPhasePendingToolUseId = current.streamPhasePendingToolUseId
        let turnStartedAt = current.turnStartedAt
        let phaseChangedAt = current.phaseChangedAt
        let submittedAt = current.submittedAt

        if (eventType === 'stream_phase') {
          const rawPhase =
            typeof semanticEvent.phase === 'string' ? semanticEvent.phase : 'idle'
          const nextPhase = rawPhase as StreamPhase
          if (nextPhase !== streamPhase) {
            const now = Date.now()
            streamPhase = nextPhase
            streamPhasePendingToolName =
              typeof semanticEvent.toolName === 'string'
                ? (semanticEvent.toolName as string)
                : null
            streamPhasePendingToolUseId =
              typeof semanticEvent.toolUseId === 'string'
                ? (semanticEvent.toolUseId as string)
                : null
            phaseChangedAt = now
            if (nextPhase === 'idle') {
              turnStartedAt = null
              submittedAt = null
            } else if (turnStartedAt === null) {
              // First non-idle phase of this turn — stamp the start
              // time. If the optimistic-submit path already stamped
              // `submittedAt`, prefer it over `now` so the elapsed
              // counter includes the gap between submit and first
              // adapter event.
              turnStartedAt = submittedAt ?? now
            }
          } else if (
            // Re-assign pending tool info even on same-phase re-emit
            // (turnId upgrade: null → real id is the classic case).
            streamPhase !== 'idle'
          ) {
            streamPhasePendingToolName =
              typeof semanticEvent.toolName === 'string'
                ? (semanticEvent.toolName as string)
                : streamPhasePendingToolName
            streamPhasePendingToolUseId =
              typeof semanticEvent.toolUseId === 'string'
                ? (semanticEvent.toolUseId as string)
                : streamPhasePendingToolUseId
          }
        } else if (eventType === 'tool_result') {
          // Tool result arrived. If it matches the pending tool we're
          // `awaiting-tool` on, move to a neutral 'requesting' phase
          // so the indicator doesn't sit amber after the tool returned.
          // The adapter's next stream_phase event (from the next
          // assistant flow's message_start) will overwrite; this is
          // the gap-filler.
          const resultToolUseId =
            typeof semanticEvent.toolUseId === 'string'
              ? (semanticEvent.toolUseId as string)
              : null
          if (
            streamPhase === 'awaiting-tool' &&
            resultToolUseId !== null &&
            resultToolUseId === streamPhasePendingToolUseId
          ) {
            streamPhase = 'requesting'
            streamPhasePendingToolName = null
            streamPhasePendingToolUseId = null
            phaseChangedAt = Date.now()
          }
        }

        // Ghost bridge — refresh the provisional ghost map from the
        // new semantic turn. This runs on every semantic tick;
        // `ghostsFromSemanticTurn` is idempotent and reference-stable
        // so no-op ticks (e.g. usage_updated events) do not churn the
        // map.
        //
        // WHY here and not inside `foldSemanticEvent`:
        //   foldSemanticEvent is intentionally agnostic to
        //   SessionRuntime — it reduces the SemanticRuntimeState
        //   sub-slice and knows nothing about sessionId or the outer
        //   runtime. The ghost map lives on SessionRuntime because
        //   it needs to survive across semantic history archival
        //   (when `currentTurn` flips to null) and because Phase 2
        //   will persist it to disk with session-scoped file names.
        //   Calling the ghost reducer at this outer boundary keeps
        //   the layering clean.
        const nextGhosts = ghostsFromSemanticTurn(
          nextSemantic.currentTurn,
          sessionId,
          current.ghosts,
        )

        // Persist each changed ghost to disk (append-only JSONL under
        // <userData>/ghost-logs). Fire-and-forget from the renderer;
        // the main-side queue drains every 100 ms. See
        // `src/main/ghostJournal.ts` for the writer and
        // `./ghosts.ts` `ghostsToPersist` for why this diff is safe.
        for (const ghost of ghostsToPersist(current.ghosts, nextGhosts)) {
          window.api.ghostAppend(sessionId, ghost)
        }

        const nextCurrent = withDerivedSessionStatus(
          appendFeedDebugLog(
            {
              ...current,
              awaitingAssistant: clearOptimisticAwaiting ? false : current.awaitingAssistant,
              semantic: nextSemantic,
              streamPhase,
              streamPhasePendingToolName,
              streamPhasePendingToolUseId,
              turnStartedAt,
              phaseChangedAt,
              submittedAt,
              ghosts: nextGhosts,
            },
            {
              layer: 'SEM',
              kind: eventType || 'semantic',
              summary: summarizeSemanticEventForDebug(semanticEvent),
              data: semanticEvent,
            },
          ),
        )
        return {
          ...prev,
          [sessionId]: nextCurrent,
        }
      })
    })

    const offTrustDialog = window.api.onSessionTrustDialog(({ sessionId, visible, workspace }) => {
      updateRuntime(sessionId, {
        pendingTrustDialog: visible ? { workspace } : null,
      })
    })

    const offResumePrompt = window.api.onSessionResumePrompt(({
      sessionId,
      visible,
      sessionAgeText,
      tokenCountText,
      options,
      selectedIndex,
    }) => {
      updateRuntime(sessionId, {
        pendingResumePrompt: visible
          ? { sessionAgeText, tokenCountText, options, selectedIndex }
          : null,
      })
    })

    const offCompactionState = window.api.onSessionCompactionState(({
      sessionId,
      visible,
      phase,
      statusText,
      errorText,
    }) => {
      updateRuntime(sessionId, {
        pendingCompaction: visible && phase
          ? { phase, statusText, errorText }
          : null,
      })
    })

    // Bulk jsonl-entry path — the ONLY entry handler now that main
    // no longer dual-emits singular events. Folds a whole burst in
    // one setRuntimes + at most one setState, grows the tool indices
    // incrementally, and sets `bootstrapping = true` for the duration
    // so Feed can suspend per-append auto-scroll + lazy-mount
    // cascades. See the deleted-handler comment higher in this file
    // and docs/superpowers/plans/2026-04-15-bootstrap-replay-perf.md
    // for the full rationale.
    //
    // Side-effects absorbed from the old singular handler:
    //   1. Codex providerSessionId capture (from session_meta).
    //   2. Codex approval request / resolve (per entry).
    //   3. Claude queue-operation bookkeeping (per entry).
    //   4. Claude providerSessionId capture (from any entry's sessionId).
    //   5. pendingCompaction clearing on compact summary entries.
    //   6. Optimistic-Codex-user reconciliation against the head row.
    const offEntries = window.api.onSessionJsonlEntries(({ sessionId, entries }) => {
      if (!entries || entries.length === 0) return

      // Two passes per burst:
      //   A — accumulate workspace-state captures (providerSessionId).
      //       Apply via ONE setState if anything changed.
      //   B — accumulate runtime mutations (entries, queue, approval,
      //       compaction). Apply via ONE setRuntimes.
      // Splitting them keeps workspace.json in sync with new
      // providerSessionId on the same tick the entries land, without
      // doing N setState calls during a 200-entry burst.

      // ---- Pass A: workspace-state captures ----
      let capturedClaudeId: string | null = null
      let capturedCodexId: string | null = null
      for (const { entry: raw } of entries) {
        if (isCodexRolloutEntry(raw)) {
          if (!capturedCodexId) {
            const id = extractCodexProviderSessionId(raw)
            if (id) capturedCodexId = id
          }
          continue
        }
        if (!capturedClaudeId) {
          const ccId = (raw as { sessionId?: string }).sessionId
          if (typeof ccId === 'string' && ccId.length > 0) {
            capturedClaudeId = ccId
          }
        }
      }
      if (capturedClaudeId || capturedCodexId) {
        setState(prev => {
          const meta = prev.sessions[sessionId]
          if (!meta) return prev
          if (meta.providerSessionId) return prev
          const id = capturedClaudeId ?? capturedCodexId
          if (!id) return prev
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [sessionId]: { ...meta, providerSessionId: id },
            },
          }
        })
      }

      // ---- Pass B: runtime mutations ----
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const seen = (seenUuidsRef.current[sessionId] ??= new Set())
        const appended: Entry[] = []
        let oldestMarker: string | null = current.historyOldestMarker
        let pendingCompaction = current.pendingCompaction
        let pendingApproval = current.pendingApproval
        let queuedMessages = current.queuedMessages
        let awaitingAssistant = current.awaitingAssistant
        // Set when a Codex user entry mapped from rollout matches the
        // optimistic head row already in current.entries. We can only
        // resolve it after the loop because the optimistic row could
        // also live in `appended` if we're processing multiple bursts.
        let dropOptimisticHead = false

        // Reuse the existing map references so downstream consumers
        // that hold them live (Feed contexts) keep working without a
        // re-subscribe. The runtime object itself gets a new top-level
        // reference below so React re-renders.
        const toolUseIndex = current.toolUseIndex
        const toolResultIndex = current.toolResultIndex

        // Rolling Codex turn id — updated when a `turn_context`
        // rollout entry arrives, then stamped onto every mapped
        // response_item in the same turn. Feeds reconcileUpstream's
        // Codex supersede branch. See codexTurnIdFromRollout for
        // the extraction rule and reconcileUpstream for the match.
        let codexCurrentTurnId: string | null = null

        for (const { entry: raw } of entries) {
          // ---- Codex rollout branch ----
          if (isCodexRolloutEntry(raw)) {
            const payload = raw.payload as Record<string, unknown> | undefined
            const turnContextId = codexTurnIdFromRollout(raw)
            if (turnContextId !== null) codexCurrentTurnId = turnContextId
            const mappedRaw = mapCodexRolloutToFeedEntries(raw)
            const mapped = mappedRaw.map(e => stampCodexTurnId(e, codexCurrentTurnId))
            const marker = mapped.length > 0 ? codexHistoryMarker(raw) : null
            if (marker && !oldestMarker) oldestMarker = marker

            // Codex exec_approval_request opens an approval pane;
            // exec_command_end with the same call_id closes it.
            if (raw.type === 'event_msg' && payload?.type === 'exec_approval_request') {
              pendingApproval = {
                callId: typeof payload.call_id === 'string' ? payload.call_id : null,
                command: Array.isArray(payload.command)
                  ? payload.command.filter(
                      (part): part is string => typeof part === 'string',
                    )
                  : [],
                workdir: typeof payload.workdir === 'string' ? payload.workdir : null,
                reason: pendingApproval?.reason,
                options: pendingApproval?.options,
                selectedIndex: pendingApproval?.selectedIndex,
              }
            } else if (
              raw.type === 'event_msg' &&
              payload?.type === 'exec_command_end' &&
              typeof payload.call_id === 'string' &&
              pendingApproval?.callId === payload.call_id
            ) {
              pendingApproval = null
            }

            // Optimistic-user reconciliation. Match the first mapped
            // user entry against either the last entry we've already
            // accumulated in this burst, or — if nothing is appended
            // yet — the tail of current.entries.
            const firstMapped = mapped[0]
            if (firstMapped?.type === 'user') {
              if (appended.length > 0) {
                const lastAppended = appended[appended.length - 1]
                if (
                  isOptimisticCodexUserEntry(lastAppended) &&
                  entryTextContent(lastAppended) === entryTextContent(firstMapped)
                ) {
                  appended.pop()
                }
              } else {
                const lastExisting = current.entries[current.entries.length - 1]
                if (
                  isOptimisticCodexUserEntry(lastExisting) &&
                  entryTextContent(lastExisting) === entryTextContent(firstMapped)
                ) {
                  dropOptimisticHead = true
                }
              }
            }

            for (const e of mapped) {
              const u = (e as { uuid?: string }).uuid
              if (u) {
                if (seen.has(u)) continue
                seen.add(u)
              }
              appended.push(e)
              indexEntryIntoMaps(e, toolUseIndex, toolResultIndex)
            }
            continue
          }

          // ---- Claude queue-operation branch ----
          // queue-operation entries are CC's internal message-queue
          // bookkeeping (see claude-code-src/utils/messageQueueManager.ts
          // for the emit sites). 'enqueue' / 'dequeue' / 'remove' —
          // the latter two are collapsed into "drop head" because we
          // don't have identity info to do better. Not pushed into
          // `entries` (would render as feed noise).
          const entryType = (raw as { type?: string }).type
          if (entryType === 'queue-operation') {
            const op = raw as {
              operation?: 'enqueue' | 'dequeue' | 'remove'
              content?: string
              timestamp?: string
            }
            if (op.operation === 'enqueue' && typeof op.content === 'string') {
              const ts = op.timestamp ?? String(Date.now())
              const already = queuedMessages.some(
                q => q.timestamp === ts && q.content === op.content,
              )
              if (!already) {
                queuedMessages = [
                  ...queuedMessages,
                  { content: op.content, timestamp: ts },
                ]
              }
            } else if (op.operation === 'dequeue' || op.operation === 'remove') {
              queuedMessages = queuedMessages.slice(1)
            }
            // Force the streaming flag on whenever the queue has items
            // so the streaming card doesn't disappear between turns
            // while CC is draining queued work.
            if (queuedMessages.length > 0) awaitingAssistant = true
            continue
          }

          // ---- Claude conversation entry branch ----
          const feedEntry =
            extractEmbeddedClaudeProgressEntry(raw as Record<string, unknown>) ??
            (raw as Entry)
          const marker = claudeHistoryMarker(raw as Record<string, unknown>)
          if (marker && !oldestMarker) oldestMarker = marker
          const uuid = (feedEntry as { uuid?: string }).uuid
          if (uuid) {
            if (seen.has(uuid)) continue
            seen.add(uuid)
          }
          if (
            !isConversationEntry(feedEntry) &&
            !isCompactBoundaryEntry(feedEntry) &&
            !isCompactSummaryEntry(feedEntry)
          ) {
            continue
          }
          if (isCompactSummaryEntry(feedEntry)) pendingCompaction = null
          appended.push(feedEntry)
          indexEntryIntoMaps(feedEntry, toolUseIndex, toolResultIndex)
        }

        const baseEntries = dropOptimisticHead
          ? current.entries.slice(0, -1)
          : current.entries

        // Ghost reconciliation — when authoritative entries land,
        // supersede any live ghost whose `(turnId, blockIndex)` they
        // replace. Runs per appended entry so ghost→real handoff is
        // synchronous with the entry becoming visible; the ghost
        // drops out of the merged view in the same render as the
        // real entry appears.
        //
        // `reconcileUpstream` is a no-op when there are no ghosts,
        // and returns the same-size Map when no ghost matched, so
        // this is cheap in the common case. Non-conversation entries
        // (system, compact_boundary) pass through untouched.
        let nextGhosts = current.ghosts
        for (const entry of appended) {
          nextGhosts = reconcileUpstream(entry, nextGhosts)
        }

        // Persist supersede records. When an upstream entry matched a
        // ghost, `reconcileUpstream` produced a new ghost snapshot
        // with `supersededBy` set; appending that to disk is how
        // crash-recovered state knows "this ghost is no longer live."
        for (const ghost of ghostsToPersist(current.ghosts, nextGhosts)) {
          window.api.ghostAppend(sessionId, ghost)
        }

        // Bail only when literally nothing changed. Approval, queue,
        // and compaction transitions can fire on bursts that don't
        // append any feed entries at all.
        // Include ghost reference equality in the no-change check:
        // reconcileUpstream preserves the same Map reference when no
        // ghost matched, so this only fires setRuntimes when ghosts
        // actually changed. Matches the treatment of queuedMessages
        // and the rest of this guard.
        const ghostsChanged = nextGhosts !== current.ghosts
        const noChange =
          appended.length === 0 &&
          !dropOptimisticHead &&
          pendingCompaction === current.pendingCompaction &&
          pendingApproval === current.pendingApproval &&
          queuedMessages === current.queuedMessages &&
          awaitingAssistant === current.awaitingAssistant &&
          !ghostsChanged
        if (noChange) return prev

        const nextRuntime = withDerivedSessionStatus(
          appendFeedDebugLog(
            {
              ...current,
              entries: appended.length > 0 || dropOptimisticHead
                ? [...baseEntries, ...appended]
                : current.entries,
              historyOldestMarker: oldestMarker,
              bootstrapping: true,
              pendingCompaction,
              pendingApproval,
              queuedMessages,
              awaitingAssistant,
              toolUseIndex,
              toolResultIndex,
              ghosts: nextGhosts,
            },
            {
              layer: 'JSONL',
              kind: 'jsonl_entries',
              summary:
                appended.length > 0 || dropOptimisticHead
                  ? `entries +${appended.length}${dropOptimisticHead ? ' · reconciled optimistic user' : ''}`
                  : 'jsonl side-effects only',
              data: {
                burstSize: entries.length,
                appendedCount: appended.length,
                droppedOptimisticHead: dropOptimisticHead,
                appended: appended.slice(-8).map(summarizeEntryForDebug),
                queuedMessages: queuedMessages.length,
                pendingApproval: pendingApproval
                  ? {
                      callId: pendingApproval.callId,
                      command: pendingApproval.command,
                    }
                  : null,
              },
            },
          ),
        )
        return {
          ...prev,
          [sessionId]: nextRuntime,
        }
      })

      // Schedule the bootstrap flip. Each burst resets the debounce
      // timer — the phase ends after ~150ms of quiet (long enough to
      // cover a laggy resume replay, short enough that the user doesn't
      // notice a deferred scroll pin).
      const existing = bootstrapTimersRef.current.get(sessionId)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        bootstrapTimersRef.current.delete(sessionId)
        setRuntimes(prev => {
          const current = prev[sessionId]
          if (!current || !current.bootstrapping) return prev
          return {
            ...prev,
            [sessionId]: appendFeedDebugLog(
              { ...current, bootstrapping: false },
              {
                layer: 'STATE',
                kind: 'bootstrap_complete',
                summary: 'bootstrap replay quiet window elapsed',
              },
            ),
          }
        })
      }, 150)
      bootstrapTimersRef.current.set(sessionId, timer)
    })

    return () => {
      offStarted()
      offScreen()
      // No singular offEntry() — see the deleted-handler comment
      // earlier in this effect. The bulk path is the only one.
      offEntries()
      offErr()
      offProcessState()
      offSemantic()
      offTrustDialog()
      offResumePrompt()
      offCompactionState()
      offExit()
      for (const t of bootstrapTimersRef.current.values()) clearTimeout(t)
      bootstrapTimersRef.current.clear()
    }
  }, [updateRuntime])

  // ---- Action: spawn a new session (main process call) ----
  //
  // Wrapped so callers don't have to touch window.api directly. Updates
  // state.sessions synchronously after main responds with an id.
  //
  // `resumeSessionId` (optional) triggers a resume: main spawns claude
  // with `--resume <uuid>` and tails the existing session file, so the
  // renderer receives the full session history as jsonl-entry events
  // immediately after started. Our own sessionId is still fresh — it's
  // a workspace-scoped identifier for routing, distinct from CC's
  // session UUID.
  const spawn = useCallback(
    async (
      cwd: string,
      opts?: {
        resumeSessionId?: string
        kind?: SessionKind
        dangerousMode?: boolean
        /** Forwarded to the spawn IPC. Used by undo-close to attach
         *  to the same tmux session that backed the closed terminal,
         *  preserving scrollback and any running process. */
        recoverTmuxName?: string
      },
    ): Promise<SessionId> => {
      const kind: SessionKind = opts?.kind ?? 'claude'
      const dangerousMode =
        opts?.dangerousMode ?? (kind !== 'terminal' ? dangerousAgentsRef.current : undefined)
      // Agent providers both accept `useProxy`; terminals ignore it.
      // Claude uses MITM proxy streaming, Codex uses a local Responses
      // proxy via `openai_base_url`.
      const useProxy = kind !== 'terminal' ? useProxyStreamingRef.current : undefined
      let sessionId: SessionId
      let tmuxName: string | undefined
      try {
        const result = await window.api.spawnSession({
          kind,
          cwd,
          resumeSessionId: opts?.resumeSessionId,
          dangerousMode,
          useProxy,
          recoverTmuxName: opts?.recoverTmuxName,
        })
        sessionId = result.sessionId
        tmuxName = result.tmuxName
      } catch (err) {
        throw new Error(sessionSpawnErrorMessage(kind, err, useProxy === true))
      }
      setState(prev => ({
        ...prev,
        sessions: {
          ...prev.sessions,
          // Persist tmuxName when main returns one — that's the
          // signal that this terminal got tmux backing and is eligible
          // for cross-restart recovery on next launch.
          [sessionId]: {
            cwd,
            kind,
            ...(tmuxName ? { tmuxName } : {}),
            ...(kind !== 'terminal' && opts?.resumeSessionId
              ? { providerSessionId: opts.resumeSessionId }
              : {}),
          },
        },
      }))
      setRuntimes(prev => ({
        ...prev,
        [sessionId]: {
          ...emptyRuntime(),
          hasOlderHistory: kind !== 'terminal' && Boolean(opts?.resumeSessionId),
        },
      }))

      // Ghost log bootstrap — fire-and-forget, no await. If a prior
      // run of cc-shell persisted ghosts for this sessionId, replay
      // them through the atp reducer and merge into the runtime's
      // ghost map. The renderer then sees the same merged feed after
      // reload as it saw before. A missing file is not an error.
      //
      // WHY behind a setTimeout 0: spawnSession above set the fresh
      // runtime via setRuntimes(prev => ...) — that update is queued
      // and will land on the next tick. Reading the ghost log and
      // applying it synchronously would run against the PREVIOUS
      // runtime snapshot and its setRuntimes would clobber the
      // fresh empty runtime. Deferring by one tick lets the empty
      // runtime land first, then the bootstrap merge runs on top.
      setTimeout(() => {
        void window.api.ghostRead(sessionId).then(rawEntries => {
          if (!rawEntries || rawEntries.length === 0) return
          const bootstrapped = reduceGhostLog(rawEntries as never[])
          if (bootstrapped.size === 0) return
          setRuntimes(prev => {
            const current = prev[sessionId]
            if (!current) return prev
            // Merge — disk ghosts only fill slots the runtime hasn't
            // already produced in this session. If a ghost for the
            // same uuid exists in-memory (rare; would mean a live
            // event beat the bootstrap read), prefer the in-memory
            // one because it's strictly fresher.
            const merged = new Map(current.ghosts)
            for (const [uuid, ghost] of bootstrapped) {
              if (!merged.has(uuid)) merged.set(uuid, ghost)
            }
            return {
              ...prev,
              [sessionId]: { ...current, ghosts: merged },
            }
          })
        }).catch(err => {
          // Ghost bootstrap failures are non-fatal — the session
          // still works, we just lose crash-recovered provisional
          // state. Log and move on.
          console.warn('[ghost] bootstrap read failed:', err)
        })
      }, 0)

      return sessionId
    },
    [],
  )

  // ---- Action: kill a session (main process call) ----
  const killSession = useCallback(async (sessionId: SessionId) => {
    await window.api.killSession(sessionId)
    setRuntimes(prev => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    setState(prev => {
      const nextSessions = { ...prev.sessions }
      delete nextSessions[sessionId]
      return { ...prev, sessions: nextSessions }
    })
    delete seenUuidsRef.current[sessionId]
    delete latestScreenRef.current[sessionId]
    // If a bootstrap debounce was in flight for this session, cancel
    // it — the session is gone; firing the deferred bootstrapping→false
    // flip later would be a no-op against a missing runtime but it's
    // cleaner to release the timer immediately.
    const timer = bootstrapTimersRef.current.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      bootstrapTimersRef.current.delete(sessionId)
    }
  }, [])

  // ---- Action: replace the focused session in-place ----
  //
  // Kills the current session in the focused leaf and spawns a new one
  // in the same position. Used by the resume flow to swap a session
  // without changing the tile tree structure — the pane stays where it
  // is, only its backing session changes.
  const replaceSession = useCallback(
    async (
      cwd: string,
      opts?: { resumeSessionId?: string; kind?: SessionKind },
    ) => {
      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab) return
      const oldId = tab.focusedSessionId
      const nextKind = opts?.kind ?? state.sessions[oldId]?.kind ?? 'claude'
      const oldDraft = latestRuntimesRef.current[oldId]?.draftInput ?? ''
      const newId = await spawn(cwd, opts)
      setRuntimes(prev => ({
        ...prev,
        [newId]: {
          ...(prev[newId] ?? emptyRuntime()),
          draftInput: oldDraft,
        },
      }))

      await window.api.killSession(oldId)
      setRuntimes(prev => {
        const next = { ...prev }
        delete next[oldId]
        return next
      })
      delete seenUuidsRef.current[oldId]
      delete latestScreenRef.current[oldId]

      // Swap the sessionId in the tree. Walk the tile tree and replace
      // every occurrence of oldId with newId (there should be exactly
      // one — the focused leaf).
      const remapNode = (n: TileNode): TileNode => {
        if (n.type === 'leaf') {
          return n.sessionId === oldId
            ? { type: 'leaf', sessionId: newId }
            : n
        }
        return { ...n, a: remapNode(n.a), b: remapNode(n.b) }
      }

      setState(prev => {
        const sessions = { ...prev.sessions }
        delete sessions[oldId]
        // Persist the replacement provider metadata immediately instead of
        // waiting for the first transcript line to round-trip back from main.
        // That wait window is usually short, but it is still a real race:
        // a workspace save or pane action that snapshots SessionMeta in that
        // gap would see "new session id, but no providerSessionId yet" and
        // could forget how to resume the pane on the next launch.
        //
        // Keeping the requested resumeSessionId here makes replaceSession the
        // single source of truth for "this pane now points at provider X's
        // persisted transcript Y", whether the trigger was the resume picker
        // or the new switch-provider flow.
        sessions[newId] = {
          ...(sessions[newId] ?? { cwd, kind: nextKind }),
          cwd,
          kind: nextKind,
          ...(opts?.resumeSessionId ? { providerSessionId: opts.resumeSessionId } : {}),
        }
        return {
          ...prev,
          tabs: prev.tabs.map(t => {
            if (t.id !== prev.activeTabId) return t
            return {
              ...t,
              root: remapNode(t.root),
              focusedSessionId:
                t.focusedSessionId === oldId ? newId : t.focusedSessionId,
            }
          }),
          sessions,
        }
      })
      return newId
    },
    [spawn, state.activeTabId, state.sessions, state.tabs],
  )

  // ---- Action: reload all live agent sessions ----
  //
  // Recreates every Claude/Codex session with the requested dangerous
  // mode, then remaps visible panes and buried records onto the fresh
  // session ids. Plain terminal sessions are left untouched.
  const reloadAgentSessions = useCallback(
    async (dangerousMode = dangerousAgentsRef.current) => {
      const current = stateRef.current
      const agentEntries = Object.entries(current.sessions).filter(([, meta]) => {
        const kind = meta.kind ?? 'claude'
        return kind === 'claude' || kind === 'codex'
      })
      if (agentEntries.length === 0) return

      const oldRuntimes = latestRuntimesRef.current
      const idMap = new Map<SessionId, SessionId>()
      const failedIds = new Set<SessionId>()
      const freshSessions: Record<SessionId, SessionMeta> = {}

      for (const [oldId, meta] of agentEntries) {
        try {
          await window.api.killSession(oldId)
        } catch {
          // Kill failures still fall through to respawn — the old
          // process may already be gone.
        }

        delete seenUuidsRef.current[oldId]
        delete latestScreenRef.current[oldId]

        try {
          const kind: SessionKind = meta.kind ?? 'claude'
          const { sessionId: newId } = await window.api.spawnSession({
            kind,
            cwd: meta.cwd,
            resumeSessionId: meta.providerSessionId,
            dangerousMode,
            useProxy: kind !== 'terminal' ? useProxyStreamingRef.current : undefined,
          })
          idMap.set(oldId, newId)
          freshSessions[newId] = { ...meta }
        } catch {
          failedIds.add(oldId)
        }
      }

      if (idMap.size === 0 && failedIds.size === 0) return

      const remapNode = (node: TileNode): TileNode => {
        if (node.type === 'leaf') {
          const mapped = idMap.get(node.sessionId)
          return mapped ? { type: 'leaf', sessionId: mapped } : node
        }
        return { ...node, a: remapNode(node.a), b: remapNode(node.b) }
      }

      setRuntimes(prev => {
        const next = { ...prev }
        for (const [oldId] of agentEntries) delete next[oldId]
        for (const [oldId, newId] of idMap.entries()) {
          const restored = emptyRuntime()
          restored.draftInput = oldRuntimes[oldId]?.draftInput ?? ''
          restored.hasOlderHistory = Boolean(freshSessions[newId]?.providerSessionId)
          next[newId] = restored
        }
        return next
      })

      setState(prev => {
        const nextSessions = { ...prev.sessions }
        for (const [oldId] of agentEntries) delete nextSessions[oldId]
        for (const [newId, meta] of Object.entries(freshSessions)) {
          nextSessions[newId] = meta
        }

        const nextTabs = prev.tabs
          .map(tab => {
            let root = remapNode(tab.root)
            for (const failedId of failedIds) {
              root = closeLeaf(root, failedId)
              if (root === null) break
            }
            if (root === null) return null
            const leaves = collectLeaves(root)
            if (leaves.length === 0) return null
            const focusedSessionId = idMap.get(tab.focusedSessionId)
              ?? (failedIds.has(tab.focusedSessionId) ? leaves[0] : tab.focusedSessionId)
            return {
              ...tab,
              root,
              focusedSessionId,
            } satisfies Tab
          })
          .filter((tab): tab is Tab => tab !== null)

        const activeTabId = nextTabs.some(tab => tab.id === prev.activeTabId)
          ? prev.activeTabId
          : (nextTabs[0]?.id ?? '')

        const nextBuried = prev.buried
          .filter(entry => !failedIds.has(entry.sessionId))
          .map(entry => ({
            ...entry,
            id: idMap.get(entry.id) ?? entry.id,
            sessionId: idMap.get(entry.sessionId) ?? entry.sessionId,
            siblingLeafId: entry.siblingLeafId
              ? (idMap.get(entry.siblingLeafId) ?? entry.siblingLeafId)
              : undefined,
          }))

        return {
          ...prev,
          tabs: nextTabs,
          activeTabId,
          sessions: nextSessions,
          buried: nextBuried,
        }
      })
    },
    [],
  )

  // ---- Action: new tab ----
  //
  // Spawns a new session in the given cwd, creates a tab with one leaf,
  // and makes it active. Pass `resumeSessionId` to resume an existing
  // CC session rather than starting a fresh one.
  const newTab = useCallback(
    async (cwd: string, resumeSessionId?: string, kind?: SessionKind) => {
      let sessionId: SessionId
      try {
        sessionId = await spawn(cwd, { resumeSessionId, kind })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to create session',
        )
        throw err
      }
      const tabId = crypto.randomUUID()
      const title = titleFromCwd(cwd)
      setState(prev => {
        const newTab: Tab = {
          id: tabId,
          title,
          root: { type: 'leaf', sessionId },
          focusedSessionId: sessionId,
        }
        return {
          ...prev,
          tabs: [...prev.tabs, newTab],
          activeTabId: tabId,
        }
      })
      return { tabId, sessionId }
    },
    [showToast, spawn],
  )

  // ---- Action: close tab ----
  const closeTab = useCallback(
    async (tabId: TabId) => {
      const tab = state.tabs.find(t => t.id === tabId)
      if (!tab) return

      // Capture undo info before killing anything.
      const tabIdx = state.tabs.findIndex(t => t.id === tabId)
      const ids = collectLeaves(tab.root)
      const allMetas: Record<SessionId, SessionMeta> = {}
      for (const id of ids) {
        if (state.sessions[id]) allMetas[id] = state.sessions[id]
      }
      undoStackRef.current.push({
        type: 'tab',
        closedAt: Date.now(),
        tab: { ...tab },
        tabIndex: tabIdx,
        sessionMetas: allMetas,
      })
      // Surface a brief undo hint. The label uses the tab title so
      // the user can confirm at a glance which thing they killed.
      showToast(`Closed “${tab.title}” — ⌘⇧T (Undo Close)`)

      // Kill every session in this tab.
      await Promise.all(ids.map(id => window.api.killSession(id)))
      setRuntimes(prev => {
        const next = { ...prev }
        for (const id of ids) delete next[id]
        return next
      })
      for (const id of ids) {
        delete seenUuidsRef.current[id]
        delete latestScreenRef.current[id]
      }
      setState(prev => {
        const tabs = prev.tabs.filter(t => t.id !== tabId)
        const sessions = { ...prev.sessions }
        for (const id of ids) delete sessions[id]
        const activeTabId =
          prev.activeTabId === tabId
            ? (tabs[0]?.id ?? '')
            : prev.activeTabId
        return { ...prev, tabs, activeTabId, sessions }
      })
      setTileTabs(prev => {
        if (!prev) return prev
        const sanitized = sanitizeTileTabsState({
          ...prev,
          tabIds: prev.tabIds.filter(id => id !== tabId),
          focusedTabId: prev.focusedTabId === tabId
            ? (prev.tabIds.find(id => id !== tabId) ?? prev.focusedTabId)
            : prev.focusedTabId,
        })
        return sanitized
      })
      setSpotlight(prev => (prev?.tabId === tabId ? null : prev))
      setReaderMode(prev => (prev?.tabId === tabId ? null : prev))
    },
    [setReaderMode, setTileTabs, state.tabs, state.sessions],
  )

  // ---- Action: split the focused pane ----
  //
  // Spawns a new session in the parent pane's cwd, inserts a new leaf
  // under a fresh split node, makes the new pane focused.
  const splitFocused = useCallback(
    async (
      direction: SplitDirection,
      kind: SessionKind = 'claude',
      /** Resume this provider session id in the new pane instead of
       *  starting fresh. Used by the duplicate-agent flow so the
       *  clone opens as a sibling pane of the source, not as a new
       *  tab (which would hide the source behind a tab switch). */
      resumeSessionId?: string,
    ) => {
      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab) return
      const parentSessionId = tab.focusedSessionId
      const parentCwd = state.sessions[parentSessionId]?.cwd
      if (!parentCwd) return

      let newSessionId: SessionId
      try {
        newSessionId = await spawn(parentCwd, { kind, resumeSessionId })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to split pane',
        )
        return
      }

      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(t => {
          if (t.id !== prev.activeTabId) return t
          return {
            ...t,
            root: splitLeaf(t.root, parentSessionId, direction, newSessionId),
            focusedSessionId: newSessionId,
          }
        }),
      }))
    },
    [showToast, spawn, state.activeTabId, state.sessions, state.tabs],
  )

  const startNewAgentPlacement = useCallback(() => {
    const tab = state.tabs.find(t => t.id === state.activeTabId)
    if (!tab) return
    openNewAgentPlacement()
  }, [openNewAgentPlacement, state.activeTabId, state.tabs])

  const commitNewAgentPlacement = useCallback(
    async (kind: SessionKind, target: PlacementTarget) => {
      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab) return
      const anchorSessionId = tab.focusedSessionId
      const cwd = state.sessions[anchorSessionId]?.cwd
      if (!cwd) return

      let newSessionId: SessionId
      try {
        newSessionId = await spawn(cwd, { kind })
      } catch (err) {
        showToast(
          err instanceof Error && err.message.length > 0
            ? err.message
            : 'Failed to create pane',
        )
        return
      }
      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(currentTab => {
          if (currentTab.id !== prev.activeTabId) return currentTab
          return {
            ...currentTab,
            root:
              target.kind === 'wrap-root'
                ? wrapRootWithLeaf(
                    currentTab.root,
                    target.direction,
                    target.side,
                    newSessionId,
                  )
                : insertBesideLeaf(
                    currentTab.root,
                    target.targetSessionId,
                    target.direction,
                    RATIO_DEFAULT,
                    target.side,
                    newSessionId,
                  ),
            focusedSessionId: newSessionId,
          }
        }),
      }))
      closeNewAgentPlacement()
    },
    [closeNewAgentPlacement, setState, showToast, spawn, state.activeTabId, state.sessions, state.tabs],
  )

  // ---- Action: close the focused pane ----
  //
  // Removes the leaf from the tree and kills its session. If the tree
  // collapses to nothing, closes the whole tab. If that was the last
  // tab, leaves the workspace in an empty state — the UI shows a
  // welcome screen prompting for a new tab.
  //
  // Before destroying anything, we capture undo info and push it onto
  // the undo-close stack so the user can restore the pane (or tab)
  // with a single command within the next 2 minutes.
  const closeFocused = useCallback(async () => {
    const tab = state.tabs.find(t => t.id === state.activeTabId)
    if (!tab) return
    const targetId = tab.focusedSessionId
    const sessionMeta = state.sessions[targetId]

    // Capture undo info BEFORE mutating the tree. Two cases:
    //   1. Pane inside a split → record the parent split's geometry
    //      and the surviving sibling's anchor leaf so we can re-split.
    //   2. Last pane in a tab → record the whole tab so we can
    //      re-insert it at the same index.
    const parentInfo = findParentSplitInfo(tab.root, targetId)
    if (parentInfo && sessionMeta) {
      undoStackRef.current.push({
        type: 'pane',
        closedAt: Date.now(),
        tabId: tab.id,
        sessionMeta,
        direction: parentInfo.direction,
        ratio: parentInfo.ratio,
        side: parentInfo.side,
        siblingLeafId: parentInfo.siblingLeafId,
      })
      // Pane-level close — show the kind+cwd basename so the user
      // can recognize which pane they killed when several look alike.
      const kindLabel = sessionMeta.kind ?? 'claude'
      const cwdBase = sessionMeta.cwd.split('/').filter(Boolean).pop() ?? sessionMeta.cwd
      showToast(`Closed ${kindLabel} pane (${cwdBase}) — ⌘⇧T (Undo Close)`)
    } else if (!parentInfo && sessionMeta) {
      // This pane IS the root — closing it kills the tab. Capture
      // the tab-level undo entry.
      const tabIdx = state.tabs.findIndex(t => t.id === tab.id)
      const allMetas: Record<SessionId, SessionMeta> = {}
      for (const leafId of collectLeaves(tab.root)) {
        if (state.sessions[leafId]) allMetas[leafId] = state.sessions[leafId]
      }
      undoStackRef.current.push({
        type: 'tab',
        closedAt: Date.now(),
        tab: { ...tab },
        tabIndex: tabIdx,
        sessionMetas: allMetas,
      })
      // Tab-level close — same shape as closeTab's toast for
      // consistency, since the user closed an entire tab here too.
      showToast(`Closed “${tab.title}” — ⌘⇧T (Undo Close)`)
    }

    await window.api.killSession(targetId)

    setRuntimes(prev => {
      const next = { ...prev }
      delete next[targetId]
      return next
    })
    delete seenUuidsRef.current[targetId]
    delete latestScreenRef.current[targetId]

    setState(prev => {
      const tabs = [...prev.tabs]
      const tabIdx = tabs.findIndex(t => t.id === prev.activeTabId)
      if (tabIdx === -1) return prev
      const currentTab = tabs[tabIdx]
      const nextRoot = closeLeaf(currentTab.root, targetId)

      if (nextRoot === null) {
        // Tab is now empty — close it and activate another tab.
        const remaining = tabs.filter((_, i) => i !== tabIdx)
        const sessions = { ...prev.sessions }
        delete sessions[targetId]
        return {
          ...prev,
          tabs: remaining,
          activeTabId: remaining[Math.max(0, tabIdx - 1)]?.id ?? '',
          sessions,
        }
      }

      const nextFocused =
        findBestRemainingFocus(currentTab.root, nextRoot, targetId) ??
        collectLeaves(nextRoot)[0]
      tabs[tabIdx] = {
        ...currentTab,
        root: nextRoot,
        focusedSessionId: nextFocused,
      }
      const sessions = { ...prev.sessions }
      delete sessions[targetId]
      return { ...prev, tabs, sessions }
    })
  }, [state.activeTabId, state.tabs, state.sessions])

  // ---- Action: close an ARBITRARY session by id ----
  //
  // Mirrors closeFocused but operates on a caller-specified session
  // instead of the active tab's focused pane. Exists so UI surfaces
  // that list multiple panes at once (e.g. the Agent Activity modal)
  // can close stale sessions without first having to focus-then-
  // close, which would jank the visible layout for every close and
  // race with React's batched setState (closeFocused reads from the
  // useCallback-captured `state`, so a focus update and a close in
  // the same tick sees stale state).
  //
  // Uses stateRef.current for the same reason buryFocused does: the
  // caller's action isn't bound to whatever happens to be active.
  const closeSession = useCallback(async (targetId: SessionId) => {
    const snapshot = stateRef.current
    const owningTab = snapshot.tabs.find(t => collectLeaves(t.root).includes(targetId))
    if (!owningTab) return
    const sessionMeta = snapshot.sessions[targetId]

    // Same two-case undo capture as closeFocused: pane-in-split vs.
    // last-pane-in-tab. Keeps ⌘⇧T working for modal-driven closes.
    const parentInfo = findParentSplitInfo(owningTab.root, targetId)
    if (parentInfo && sessionMeta) {
      undoStackRef.current.push({
        type: 'pane',
        closedAt: Date.now(),
        tabId: owningTab.id,
        sessionMeta,
        direction: parentInfo.direction,
        ratio: parentInfo.ratio,
        side: parentInfo.side,
        siblingLeafId: parentInfo.siblingLeafId,
      })
      const kindLabel = sessionMeta.kind ?? 'claude'
      const cwdBase = sessionMeta.cwd.split('/').filter(Boolean).pop() ?? sessionMeta.cwd
      showToast(`Closed ${kindLabel} pane (${cwdBase}) — ⌘⇧T (Undo Close)`)
    } else if (!parentInfo && sessionMeta) {
      const tabIdx = snapshot.tabs.findIndex(t => t.id === owningTab.id)
      const allMetas: Record<SessionId, SessionMeta> = {}
      for (const leafId of collectLeaves(owningTab.root)) {
        if (snapshot.sessions[leafId]) allMetas[leafId] = snapshot.sessions[leafId]
      }
      undoStackRef.current.push({
        type: 'tab',
        closedAt: Date.now(),
        tab: { ...owningTab },
        tabIndex: tabIdx,
        sessionMetas: allMetas,
      })
      showToast(`Closed “${owningTab.title}” — ⌘⇧T (Undo Close)`)
    }

    await window.api.killSession(targetId)

    setRuntimes(prev => {
      const next = { ...prev }
      delete next[targetId]
      return next
    })
    delete seenUuidsRef.current[targetId]
    delete latestScreenRef.current[targetId]

    setState(prev => {
      const tabs = [...prev.tabs]
      const tabIdx = tabs.findIndex(t => t.id === owningTab.id)
      // Tab may have been closed between modal-open and confirm.
      // Treat that as a no-op — the row will disappear on next
      // render anyway via the "visible sessions" selector.
      if (tabIdx === -1) return prev
      const currentTab = tabs[tabIdx]
      const nextRoot = closeLeaf(currentTab.root, targetId)

      if (nextRoot === null) {
        const remaining = tabs.filter((_, i) => i !== tabIdx)
        const sessions = { ...prev.sessions }
        delete sessions[targetId]
        // Only retarget activeTabId if we just removed the active
        // tab. Closing a pane in a BACKGROUND tab from the modal
        // must not yank the user out of the tab they see when the
        // modal closes.
        const nextActiveTabId = prev.activeTabId === owningTab.id
          ? (remaining[Math.max(0, tabIdx - 1)]?.id ?? '')
          : prev.activeTabId
        return {
          ...prev,
          tabs: remaining,
          activeTabId: nextActiveTabId,
          sessions,
        }
      }

      const nextFocused =
        findBestRemainingFocus(currentTab.root, nextRoot, targetId) ??
        collectLeaves(nextRoot)[0]
      tabs[tabIdx] = {
        ...currentTab,
        root: nextRoot,
        focusedSessionId: nextFocused,
      }
      const sessions = { ...prev.sessions }
      delete sessions[targetId]
      return { ...prev, tabs, sessions }
    })
  }, [showToast])

  // ---- Action: bury focused pane ----
  //
  // Removes the focused pane from the visible layout without killing
  // the underlying session. The session keeps running in the
  // background and remains eligible for revive.
  const requestBuryFocused = useCallback(() => {
    const tab = stateRef.current.tabs.find(t => t.id === stateRef.current.activeTabId)
    if (!tab) return
    openBuryPrompt(tab.focusedSessionId)
  }, [openBuryPrompt])

  const buryFocused = useCallback((note?: string, targetSessionId?: SessionId) => {
    // The bury prompt is modal on a specific session, not a specific
    // tab. It can outlive a tab switch: user opens the prompt on
    // pane X in tab A, switches to tab B, then hits Enter. Earlier
    // we resolved `tab` via `state.activeTabId`, which meant that
    // confirm-after-switch mutated tab B's tree even though targetId
    // still pointed at pane X in tab A. Resolve the owning tab from
    // the target session instead.
    const snapshot = stateRef.current
    const activeTab = snapshot.tabs.find(t => t.id === snapshot.activeTabId)
    const targetId = targetSessionId ?? activeTab?.focusedSessionId
    if (!targetId) return

    const owningTab = snapshot.tabs.find(t => collectLeaves(t.root).includes(targetId))
    if (!owningTab) return

    const sessionMeta = snapshot.sessions[targetId]
    if (!sessionMeta) return

    const parentInfo = findParentSplitInfo(owningTab.root, targetId)
    const tabIndex = snapshot.tabs.findIndex(t => t.id === owningTab.id)
    const buriedRecord: BuriedPaneRecord = {
      id: targetId,
      sessionId: targetId,
      sessionMeta,
      buriedAt: Date.now(),
      sourceTabId: owningTab.id,
      sourceTabTitle: owningTab.title,
      sourceTabIndex: tabIndex,
      direction: parentInfo?.direction,
      ratio: parentInfo?.ratio,
      side: parentInfo?.side,
      siblingLeafId: parentInfo?.siblingLeafId,
      note: note?.trim() ? note.trim() : undefined,
    }

    const kindLabel = sessionMeta.kind ?? 'claude'
    const cwdBase = sessionMeta.cwd.split('/').filter(Boolean).pop() ?? sessionMeta.cwd
    showToast(`Buried ${kindLabel} pane (${cwdBase})`)

    setState(prev => {
      const tabs = [...prev.tabs]
      const tabIdx = tabs.findIndex(t => t.id === owningTab.id)
      // Tab may have been closed between prompt-open and confirm.
      // Treat that as a no-op rather than mutating an unrelated tab.
      if (tabIdx === -1) return prev

      const currentTab = tabs[tabIdx]
      const nextRoot = closeLeaf(currentTab.root, targetId)
      if (nextRoot === null) {
        const remaining = tabs.filter((_, i) => i !== tabIdx)
        // Only retarget activeTabId if we just removed the active
        // tab. Burying a pane in a background tab must not yank the
        // user out of the tab they're currently looking at.
        const nextActiveTabId = prev.activeTabId === owningTab.id
          ? (remaining[Math.max(0, tabIdx - 1)]?.id ?? '')
          : prev.activeTabId
        return {
          ...prev,
          tabs: remaining,
          activeTabId: nextActiveTabId,
          buried: [
            ...prev.buried.filter(entry => entry.sessionId !== targetId),
            buriedRecord,
          ],
        }
      }

      const nextFocused =
        findBestRemainingFocus(currentTab.root, nextRoot, targetId) ??
        collectLeaves(nextRoot)[0]
      tabs[tabIdx] = {
        ...currentTab,
        root: nextRoot,
        focusedSessionId: nextFocused,
      }
      return {
        ...prev,
        tabs,
        buried: [
          ...prev.buried.filter(entry => entry.sessionId !== targetId),
          buriedRecord,
        ],
      }
    })
    setSpotlight(prev => (prev?.tabId === owningTab.id ? null : prev))
    closeBuryPrompt()
  }, [closeBuryPrompt, showToast])

  // ---- Action: revive buried pane ----
  //
  // Restores a buried session into the most plausible visible location.
  // First choice is the original sibling anchor, then the original tab,
  // then the best current tab by cwd/kind/title affinity, and finally
  // a fresh single-pane tab if no good target exists.
  const reviveBuried = useCallback((buriedId: string) => {
    const current = stateRef.current
    const entry = current.buried.find(item => item.id === buriedId)
    if (!entry) return

    const chooseFallbackTab = (): Tab | null => {
      const scored = current.tabs
        .map(tab => {
          let score = 0
          if (tab.id === entry.sourceTabId) score += 100
          if (tab.title === entry.sourceTabTitle) score += 20
          const leafIds = collectLeaves(tab.root)
          for (const leafId of leafIds) {
            const meta = current.sessions[leafId]
            if (!meta) continue
            if (meta.cwd === entry.sessionMeta.cwd) score += 15
            if ((meta.kind ?? 'claude') === (entry.sessionMeta.kind ?? 'claude')) score += 5
          }
          return { tab, score }
        })
        .filter(candidate => candidate.score > 0)
        .sort((a, b) => b.score - a.score)
      return scored[0]?.tab ?? current.tabs[0] ?? null
    }

    const anchorTab = entry.siblingLeafId
      ? current.tabs.find(tab => collectLeaves(tab.root).includes(entry.siblingLeafId!))
      : null
    const targetTab = anchorTab ?? chooseFallbackTab()

    setState(prev => {
      const nextBuried = prev.buried.filter(item => item.id !== buriedId)

      if (!targetTab) {
        const tabId = crypto.randomUUID()
        const title = titleFromCwd(entry.sessionMeta.cwd)
        const revivedTab: Tab = {
          id: tabId,
          title,
          root: { type: 'leaf', sessionId: entry.sessionId },
          focusedSessionId: entry.sessionId,
        }
        return {
          ...prev,
          tabs: [...prev.tabs, revivedTab],
          activeTabId: tabId,
          buried: nextBuried,
        }
      }

      const target = prev.tabs.find(tab => tab.id === targetTab.id)
      if (!target) {
        const tabId = crypto.randomUUID()
        const title = titleFromCwd(entry.sessionMeta.cwd)
        const revivedTab: Tab = {
          id: tabId,
          title,
          root: { type: 'leaf', sessionId: entry.sessionId },
          focusedSessionId: entry.sessionId,
        }
        return {
          ...prev,
          tabs: [...prev.tabs, revivedTab],
          activeTabId: tabId,
          buried: nextBuried,
        }
      }

      const leafIds = collectLeaves(target.root)
      const cwdLeaf =
        leafIds.find(leafId => prev.sessions[leafId]?.cwd === entry.sessionMeta.cwd) ?? null
      const anchorLeafId =
        (entry.siblingLeafId && leafIds.includes(entry.siblingLeafId))
          ? entry.siblingLeafId
          : (cwdLeaf ?? target.focusedSessionId ?? leafIds[0] ?? null)

      if (!anchorLeafId) {
        const tabId = crypto.randomUUID()
        const title = titleFromCwd(entry.sessionMeta.cwd)
        const revivedTab: Tab = {
          id: tabId,
          title,
          root: { type: 'leaf', sessionId: entry.sessionId },
          focusedSessionId: entry.sessionId,
        }
        return {
          ...prev,
          tabs: [...prev.tabs, revivedTab],
          activeTabId: tabId,
          buried: nextBuried,
        }
      }

      const revivedRoot = insertBesideLeaf(
        target.root,
        anchorLeafId,
        entry.direction ?? 'vertical',
        entry.ratio ?? RATIO_DEFAULT,
        entry.side ?? 'b',
        entry.sessionId,
      )

      return {
        ...prev,
        tabs: prev.tabs.map(tab =>
          tab.id === target.id
            ? {
                ...tab,
                root: revivedRoot,
                focusedSessionId: entry.sessionId,
              }
            : tab,
        ),
        activeTabId: target.id,
        buried: nextBuried,
      }
    })
  }, [])

  // ---- Action: focus a specific session in the active tab ----
  const focusSession = useCallback((sessionId: SessionId) => {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t =>
        t.id === prev.activeTabId ? { ...t, focusedSessionId: sessionId } : t,
      ),
    }))
    setSpotlight(prev => (
      prev && prev.tabId === stateRef.current.activeTabId
        ? { ...prev, focusedSessionId: sessionId }
        : prev
    ))
  }, [])

  const focusSessionInTab = useCallback((tabId: TabId, sessionId: SessionId) => {
    setState(prev => ({
      ...prev,
      activeTabId: tabId,
      tabs: prev.tabs.map(t =>
        t.id === tabId ? { ...t, focusedSessionId: sessionId } : t,
      ),
    }))
    setSpotlight(prev => (
      prev && prev.tabId === tabId
        ? { ...prev, focusedSessionId: sessionId }
        : prev
    ))
    setTileTabs(prev => (
      prev && prev.tabIds.includes(tabId)
        ? { ...prev, focusedTabId: tabId }
        : prev
    ))
  }, [])

  // ---- Action: navigate focus geometrically (alt-hjkl) ----
  const navigate = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down') => {
      const tab = state.tabs.find(t => t.id === state.activeTabId)
      if (!tab) return
      const next = findDirectionalNeighbor(tab.root, tab.focusedSessionId, direction)
      if (next) focusSession(next)
    },
    [focusSession, state.activeTabId, state.tabs],
  )

  // ---- Action: activate a tab by id or index ----
  const activateTab = useCallback((tabId: TabId) => {
    setState(prev => ({ ...prev, activeTabId: tabId }))
    setSpotlight(null)
    // Preserve tile-tabs mode when the activated tab is part of the
    // tiled set — just shift the focused tile. If it's NOT part of
    // the set, leave tile-tabs ALONE rather than nuking the mode.
    // The previous behavior (setting null) caused the tile layout to
    // silently collapse whenever the user clicked any other tab in
    // the bar, which read as a phantom "auto-deselect."
    setTileTabs(prev => {
      if (!prev) return prev
      if (prev.tabIds.includes(tabId)) {
        return { ...prev, focusedTabId: tabId }
      }
      return prev
    })
  }, [])

  const activateTabByIndex = useCallback((index: number) => {
    setState(prev => {
      const t = prev.tabs[index]
      return t ? { ...prev, activeTabId: t.id } : prev
    })
    setSpotlight(null)
    // Same preservation rule as activateTab — see comment there.
    setTileTabs(prev => {
      const target = stateRef.current.tabs[index]
      if (!prev) return prev
      if (!target) return prev
      if (prev.tabIds.includes(target.id)) {
        return { ...prev, focusedTabId: target.id }
      }
      return prev
    })
  }, [])

  const nextTab = useCallback(() => {
    const tiled = tileTabs
    if (tiled && tiled.tabIds.length > 1) {
      const idx = tiled.tabIds.indexOf(tiled.focusedTabId)
      const nextId = tiled.tabIds[(idx + 1 + tiled.tabIds.length) % tiled.tabIds.length]
      setState(prev => ({ ...prev, activeTabId: nextId }))
      setTileTabs(prev => (prev ? { ...prev, focusedTabId: nextId } : prev))
      return
    }
    setState(prev => {
      const idx = prev.tabs.findIndex(t => t.id === prev.activeTabId)
      if (idx === -1) return prev
      const next = prev.tabs[(idx + 1) % prev.tabs.length]
      return { ...prev, activeTabId: next.id }
    })
    setSpotlight(null)
  }, [tileTabs])

  const prevTab = useCallback(() => {
    const tiled = tileTabs
    if (tiled && tiled.tabIds.length > 1) {
      const idx = tiled.tabIds.indexOf(tiled.focusedTabId)
      const nextId =
        tiled.tabIds[(idx - 1 + tiled.tabIds.length) % tiled.tabIds.length]
      setState(prev => ({ ...prev, activeTabId: nextId }))
      setTileTabs(prev => (prev ? { ...prev, focusedTabId: nextId } : prev))
      return
    }
    setState(prev => {
      const idx = prev.tabs.findIndex(t => t.id === prev.activeTabId)
      if (idx === -1) return prev
      const next = prev.tabs[(idx - 1 + prev.tabs.length) % prev.tabs.length]
      return { ...prev, activeTabId: next.id }
    })
    setSpotlight(null)
  }, [tileTabs])

  const toggleSpotlight = useCallback(() => {
    const current = stateRef.current
    const activeTab = current.tabs.find(t => t.id === current.activeTabId)
    if (!activeTab) return
    setSpotlight(prev => {
      if (prev?.tabId === activeTab.id) return null
      return {
        tabId: activeTab.id,
        focusedSessionId: activeTab.focusedSessionId,
      }
    })
  }, [])

  const setSpotlightSession = useCallback((sessionId: SessionId) => {
    setSpotlight(prev => (prev ? { ...prev, focusedSessionId: sessionId } : prev))
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t =>
        t.id === prev.activeTabId ? { ...t, focusedSessionId: sessionId } : t,
      ),
    }))
  }, [])

  // ReaderMode toggle. Mirrors toggleSpotlight: enters with the
  // active tab's currently-focused session, exits if already on for
  // the active tab. Closes Spotlight on entry; tile-tabs are preserved
  // in state and suppressed by App.tsx render precedence.
  const toggleReaderMode = useCallback(() => {
    const current = stateRef.current
    const activeTab = current.tabs.find(t => t.id === current.activeTabId)
    if (!activeTab) return
    setSpotlight(null)
    setReaderMode(prev => {
      if (prev?.tabId === activeTab.id) return null
      return {
        tabId: activeTab.id,
        focusedSessionId: activeTab.focusedSessionId,
      }
    })
  }, [])

  // Switch which session is being read inside ReaderMode. Mirrors
  // setSpotlightSession exactly — also updates the tab's
  // focusedSessionId so leaving Reader returns to that pane.
  const setReaderModeSession = useCallback((sessionId: SessionId) => {
    setReaderMode(prev => (prev ? { ...prev, focusedSessionId: sessionId } : prev))
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t =>
        t.id === prev.activeTabId ? { ...t, focusedSessionId: sessionId } : t,
      ),
    }))
  }, [])

  const openTileTabs = useCallback(
    (tabIds: TabId[], direction: SplitDirection = 'vertical') => {
      const current = stateRef.current
      const valid = tabIds.filter(id => current.tabs.some(t => t.id === id))
      if (valid.length < 2) return
      const focusedTabId = valid.includes(current.activeTabId)
        ? current.activeTabId
        : valid[0]
      setSpotlight(null)
      setTileTabs({
        tabIds: valid,
        focusedTabId,
        direction,
        ratios: equalRatios(valid.length),
      })
      setState(prev => ({ ...prev, activeTabId: focusedTabId }))
    },
    [],
  )

  const closeTileTabs = useCallback(() => {
    setTileTabs(null)
  }, [])

  const focusTiledTab = useCallback((tabId: TabId) => {
    setTileTabs(prev => (
      prev && prev.tabIds.includes(tabId)
        ? { ...prev, focusedTabId: tabId }
        : prev
    ))
    setState(prev => ({ ...prev, activeTabId: tabId }))
  }, [])

  const focusTiledTabByIndex = useCallback((index: number) => {
    setTileTabs(prev => {
      if (!prev) return prev
      const tabId = prev.tabIds[index]
      if (!tabId) return prev
      setState(statePrev => ({ ...statePrev, activeTabId: tabId }))
      return { ...prev, focusedTabId: tabId }
    })
  }, [])

  const resizeFocusedTiledTab = useCallback((delta: number) => {
    setTileTabs(prev => {
      if (!prev || prev.tabIds.length < 2) return prev
      const idx = prev.tabIds.indexOf(prev.focusedTabId)
      if (idx === -1) return prev

      const leftIndex = idx === prev.tabIds.length - 1 ? idx - 1 : idx
      const rightIndex = idx === prev.tabIds.length - 1 ? idx : idx + 1
      if (leftIndex < 0 || rightIndex >= prev.ratios.length) return prev

      const nextRatios = [...prev.ratios]
      const signedDelta = idx === prev.tabIds.length - 1 ? -delta : delta
      const nextLeft = nextRatios[leftIndex] + signedDelta
      const nextRight = nextRatios[rightIndex] - signedDelta
      const minRatio = 0.12
      if (nextLeft < minRatio || nextRight < minRatio) return prev

      nextRatios[leftIndex] = nextLeft
      nextRatios[rightIndex] = nextRight
      return {
        ...prev,
        ratios: normalizeRatios(nextRatios),
      }
    })
  }, [])

  const resizeTiledTabByIndex = useCallback((index: number, delta: number) => {
    setTileTabs(prev => {
      if (!prev || prev.tabIds.length < 2) return prev
      if (index < 0 || index >= prev.tabIds.length) return prev

      const leftIndex = index === prev.tabIds.length - 1 ? index - 1 : index
      const rightIndex = index === prev.tabIds.length - 1 ? index : index + 1
      if (leftIndex < 0 || rightIndex >= prev.ratios.length) return prev

      const nextRatios = [...prev.ratios]
      const signedDelta = index === prev.tabIds.length - 1 ? -delta : delta
      const nextLeft = nextRatios[leftIndex] + signedDelta
      const nextRight = nextRatios[rightIndex] - signedDelta
      const minRatio = 0.12
      if (nextLeft < minRatio || nextRight < minRatio) return prev

      nextRatios[leftIndex] = nextLeft
      nextRatios[rightIndex] = nextRight
      return {
        ...prev,
        ratios: normalizeRatios(nextRatios),
      }
    })
  }, [])

  // ---- Action: adjust the ratio of the split containing the focused pane ----
  const resizeFocused = useCallback((delta: number) => {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t => {
        if (t.id !== prev.activeTabId) return t
        return {
          ...t,
          root: adjustNearestSplitRatio(t.root, t.focusedSessionId, delta),
        }
      }),
    }))
  }, [])

  // ---- Action: directional resize (⌥⇧← → ↑ ↓) ----
  //
  // Grows the focused pane toward the given direction by `delta`. See
  // resizeInDirection in treeOps.ts for the full tmux-style semantics.
  const resizeFocusedDirectional = useCallback(
    (direction: 'left' | 'right' | 'up' | 'down', delta: number) => {
      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(t => {
          if (t.id !== prev.activeTabId) return t
          return {
            ...t,
            root: resizeInDirection(t.root, t.focusedSessionId, direction, delta),
          }
        }),
      }))
    },
    [],
  )

  // ---- Action: set the ratio of a specific split (for drag resize) ----
  // Walks the tree and finds the split whose `a` side contains fromId
  // and whose `b` side contains toId, then sets its ratio directly.
  const setSplitRatio = useCallback(
    (fromSessionId: SessionId, toSessionId: SessionId, ratio: number) => {
      setState(prev => ({
        ...prev,
        tabs: prev.tabs.map(t => {
          if (t.id !== prev.activeTabId) return t
          return { ...t, root: setRatioBetween(t.root, fromSessionId, toSessionId, ratio) }
        }),
      }))
    },
    [],
  )

  const setSplitRatioInTab = useCallback(
    (tabId: TabId, fromSessionId: SessionId, toSessionId: SessionId, ratio: number) => {
      setState(prev => ({
        ...prev,
        activeTabId: tabId,
        tabs: prev.tabs.map(t => {
          if (t.id !== tabId) return t
          return { ...t, root: setRatioBetween(t.root, fromSessionId, toSessionId, ratio) }
        }),
      }))
      setTileTabs(prev => (
        prev && prev.tabIds.includes(tabId)
          ? { ...prev, focusedTabId: tabId }
          : prev
      ))
    },
    [],
  )

  // ---- Update streaming baseline for a session (called from TileLeaf on submit) ----
  const setStreamingBaseline = useCallback(
    (sessionId: SessionId, baseline: string | null) => {
      // Pair the baseline write with a synthetic `submitting` phase
      // and a `submittedAt` timestamp. This covers the gap between
      // the user pressing Enter and the adapter's first `requesting`
      // event landing (can be 100-500ms on a cold proxy). Without it
      // the in-feed WorkIndicator would render nothing during that
      // window, making the app look unresponsive to the submit.
      // The adapter's first stream_phase event will transition
      // phase → 'requesting' and reuse `submittedAt` as turnStartedAt.
      const now = Date.now()
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const next = withDerivedSessionStatus(
          appendFeedDebugLog(
            {
              ...current,
              streamingBaseline: baseline,
              awaitingAssistant: true,
              streamPhase: 'submitting',
              submittedAt: now,
              phaseChangedAt: now,
              turnStartedAt: now,
            },
            {
              layer: 'STATE',
              kind: 'submit',
              summary: baseline ? 'submit started with baseline' : 'submit started',
              data: { hasBaseline: baseline !== null, baselineLength: baseline?.length ?? 0 },
            },
          ),
        )
        return {
          ...prev,
          [sessionId]: next,
        }
      })
    },
    [],
  )

  // Codex live rendering is TUI-first, with rollout JSON as a later source
  // of truth. That means a broken/missing rollout attach should NOT leave the
  // feed blank after submit. We add a local user row immediately and reconcile
  // it away when the real rollout user message shows up.
  const addOptimisticCodexUserEntry = useCallback((sessionId: SessionId, text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    setRuntimes(prev => {
      const current = prev[sessionId] ?? emptyRuntime()
      const last = current.entries[current.entries.length - 1]
      if (isOptimisticCodexUserEntry(last) && entryTextContent(last) === trimmed) {
        return prev
      }
      const optimistic: Entry = {
        type: 'user',
        uuid: `optimistic-codex-user:${Date.now()}`,
        parentUuid: null,
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [{ type: 'text', text: trimmed }],
        },
      }
      return {
        ...prev,
        [sessionId]: appendFeedDebugLog(
          {
            ...current,
            entries: [...current.entries, optimistic],
          },
          {
            layer: 'STATE',
            kind: 'optimistic_user_add',
            summary: `optimistic user row added · ${trimmed.slice(0, 80)}`,
            data: { text: trimmed },
          },
        ),
      }
    })
  }, [])

  const removeOptimisticCodexUserEntry = useCallback((sessionId: SessionId, text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    setRuntimes(prev => {
      const current = prev[sessionId]
      if (!current || current.entries.length === 0) return prev
      const last = current.entries[current.entries.length - 1]
      if (!isOptimisticCodexUserEntry(last) || entryTextContent(last) !== trimmed) {
        return prev
      }
      return {
        ...prev,
        [sessionId]: appendFeedDebugLog(
          {
            ...current,
            entries: current.entries.slice(0, -1),
          },
          {
            layer: 'STATE',
            kind: 'optimistic_user_remove',
            summary: `optimistic user row removed · ${trimmed.slice(0, 80)}`,
            data: { text: trimmed },
          },
        ),
      }
    })
  }, [])

  // ---- Update the per-session draft input (composer text) ----
  //
  // Called from TileLeaf on every onChange/onKeyDown that mutates the
  // composer text. Lives in runtime so it survives TileLeaf unmount
  // when the user switches tabs. See SessionRuntime.draftInput for
  // the reasoning.
  // Draft version counter — bumped on every draft change so the save
  // effect picks it up without watching the full runtimes object.
  const [draftVersion, setDraftVersion] = useState(0)

  const setDraftInput = useCallback(
    (sessionId: SessionId, text: string) => {
      updateRuntime(sessionId, { draftInput: text })
      setDraftVersion(v => v + 1)
    },
    [updateRuntime],
  )

  const setDraftImages = useCallback(
    (
      sessionId: SessionId,
      next:
        | SessionRuntime['draftImages']
        | ((prev: SessionRuntime['draftImages']) => SessionRuntime['draftImages']),
    ) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const draftImages =
          typeof next === 'function'
            ? next(current.draftImages)
            : next
        return {
          ...prev,
          [sessionId]: {
            ...current,
            draftImages,
          },
        }
      })
      setDraftVersion(v => v + 1)
    },
    [],
  )

  // ---- Pane toast: transient feedback above the composer ----
  //
  // Single-slot, auto-dismiss. Calling showPaneToast while a previous
  // toast is still visible replaces it and resets the timer. The
  // timeout ref lives outside React state so we can clear it without
  // causing a re-render.
  const paneToastTimers = useRef<Record<SessionId, ReturnType<typeof setTimeout>>>({})

  const showPaneToast = useCallback(
    (sessionId: SessionId, message: string, durationMs = 2000) => {
      // Clear any in-flight timer for this pane.
      const prev = paneToastTimers.current[sessionId]
      if (prev) clearTimeout(prev)

      updateRuntime(sessionId, { paneToast: message })

      paneToastTimers.current[sessionId] = setTimeout(() => {
        updateRuntime(sessionId, { paneToast: null })
        delete paneToastTimers.current[sessionId]
      }, durationMs)
    },
    [updateRuntime],
  )

  const switchFocusedProvider = useCallback(async () => {
    const current = stateRef.current
    const tab = current.tabs.find(t => t.id === current.activeTabId)
    if (!tab) return

    const sourceSessionId = tab.focusedSessionId
    const meta = current.sessions[sourceSessionId]
    if (!meta) return

    const sourceKind = meta.kind ?? 'claude'
    if (sourceKind !== 'claude' && sourceKind !== 'codex') {
      showPaneToast(sourceSessionId, 'Only Claude and Codex panes can switch provider')
      return
    }
    if (!meta.providerSessionId) {
      showPaneToast(sourceSessionId, 'Provider session id is not ready yet')
      return
    }

    try {
      // The translated target transcript must be created BEFORE we replace the
      // live pane. If translation fails, the current provider process should
      // stay untouched and the user should keep their running session instead
      // of being dropped into a dead pane.
      const result = await window.api.switchProvider({
        sourceKind,
        sourceProviderSessionId: meta.providerSessionId,
        cwd: meta.cwd,
      })

      const newSessionId = await replaceSession(meta.cwd, {
        kind: result.targetKind,
        resumeSessionId: result.targetProviderSessionId,
      })
      if (!newSessionId) return

      showPaneToast(
        newSessionId,
        result.targetKind === 'codex' ? 'Switched to Codex' : 'Switched to Claude',
      )
    } catch (err) {
      const message =
        err instanceof Error && err.message.length > 0
          ? err.message
          : 'Provider switch failed'
      showPaneToast(sourceSessionId, message)
    }
  }, [replaceSession, showPaneToast])

  const reloadFocusedAgent = useCallback(async () => {
    const current = stateRef.current
    const tab = current.tabs.find(t => t.id === current.activeTabId)
    if (!tab) return

    const sourceSessionId = tab.focusedSessionId
    const meta = current.sessions[sourceSessionId]
    if (!meta) return

    const kind = meta.kind ?? 'claude'
    if (kind !== 'claude' && kind !== 'codex') {
      showPaneToast(sourceSessionId, 'Only Claude and Codex panes can reload')
      return
    }
    if (!meta.providerSessionId) {
      showPaneToast(sourceSessionId, 'Provider session id is not ready yet')
      return
    }

    try {
      const newSessionId = await replaceSession(meta.cwd, {
        kind,
        resumeSessionId: meta.providerSessionId,
      })
      if (!newSessionId) return
      showPaneToast(
        newSessionId,
        kind === 'codex' ? 'Codex reloaded' : 'Claude reloaded',
      )
    } catch (err) {
      const message =
        err instanceof Error && err.message.length > 0
          ? err.message
          : 'Reload failed'
      showPaneToast(sourceSessionId, message)
    }
  }, [replaceSession, showPaneToast])

  const loadOlderHistory = useCallback(async (sessionId: SessionId) => {
    const currentState = stateRef.current
    const meta = currentState.sessions[sessionId]
    const runtime = latestRuntimesRef.current[sessionId] ?? emptyRuntime()
    if (!meta) return

    const kind = meta.kind ?? 'claude'
    if ((kind !== 'claude' && kind !== 'codex') || !meta.providerSessionId) return
    if (!runtime.hasOlderHistory || runtime.loadingOlderHistory) return
    if (!runtime.historyOldestMarker) {
      updateRuntime(sessionId, { hasOlderHistory: false, loadingOlderHistory: false })
      return
    }

    updateRuntime(sessionId, { loadingOlderHistory: true })

    try {
      const chunk = await window.api.loadOlderHistory({
        kind,
        cwd: meta.cwd,
        providerSessionId: meta.providerSessionId,
        beforeMarker: runtime.historyOldestMarker,
        limit: 200,
      })

      const seen = (seenUuidsRef.current[sessionId] ??= new Set())
      const prepend: Entry[] = []
      let oldestMarker: string | null = runtime.historyOldestMarker
      // Same rolling Codex turn id as the live JSONL ingest path —
      // loadOlderHistory walks the rollout stream linearly too, so a
      // `turn_context` marker seen during pagination still stamps the
      // response_items that come after it. See codexTurnIdFromRollout.
      let codexPaginationTurnId: string | null = null

      for (const rawEntry of chunk.entries) {
        if (kind === 'codex') {
          const marker = codexHistoryMarker(rawEntry)
          const turnContextId = codexTurnIdFromRollout(rawEntry)
          if (turnContextId !== null) codexPaginationTurnId = turnContextId
          const mappedRaw = mapCodexRolloutToFeedEntries(rawEntry)
          const mapped = mappedRaw.map(e => stampCodexTurnId(e, codexPaginationTurnId))
          if (mapped.length > 0 && oldestMarker === runtime.historyOldestMarker) {
            oldestMarker = marker
          }
          for (const entry of mapped) {
            const uuid = (entry as { uuid?: string }).uuid
            if (uuid && seen.has(uuid)) continue
            if (uuid) seen.add(uuid)
            prepend.push(entry)
          }
          continue
        }

        const feedEntry =
          extractEmbeddedClaudeProgressEntry(rawEntry) ??
          (rawEntry as Entry)
        const marker = claudeHistoryMarker(rawEntry)
        if (!(
          isConversationEntry(feedEntry) ||
          isCompactBoundaryEntry(feedEntry) ||
          isCompactSummaryEntry(feedEntry)
        )) {
          continue
        }
        if (marker && oldestMarker === runtime.historyOldestMarker) {
          oldestMarker = marker
        }
        const uuid = (feedEntry as { uuid?: string }).uuid
        if (uuid && seen.has(uuid)) continue
        if (uuid) seen.add(uuid)
        prepend.push(feedEntry)
      }

      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        return {
          ...prev,
          [sessionId]: {
            ...current,
            entries: prepend.length > 0 ? [...prepend, ...current.entries] : current.entries,
            historyOldestMarker: oldestMarker ?? current.historyOldestMarker,
            hasOlderHistory: chunk.hasMore || prepend.length === 0,
            loadingOlderHistory: false,
          },
        }
      })
    } catch (err) {
      console.warn('[history] load older failed', err)
      updateRuntime(sessionId, { loadingOlderHistory: false })
    }
  }, [updateRuntime])

  useEffect(() => {
    for (const [sessionId, runtime] of Object.entries(runtimes)) {
      if (runtime.feedDebugLog.length === 0) continue
      const lastPersistedId = persistedFeedDebugIdRef.current[sessionId] ?? 0
      const pending = runtime.feedDebugLog.filter(entry => entry.id > lastPersistedId)
      if (pending.length === 0) continue
      persistedFeedDebugIdRef.current[sessionId] = pending[pending.length - 1]?.id ?? lastPersistedId
      void window.api
        .appendFeedDebugLog({
          sessionId,
          entries: pending.map(entry => ({
            id: entry.id,
            ts: entry.ts,
            tMs: entry.tMs,
            layer: entry.layer,
            kind: entry.kind,
            summary: entry.summary,
            data: entry.data,
          })),
        })
        .catch(err => {
          // eslint-disable-next-line no-console
          console.warn(`[feed-debug ${sessionId.slice(0, 8)}] append failed`, err)
        })
    }
  }, [runtimes])

  // ---- Copy Assistant picker actions ----
  //
  // pickerEnter      — toggles the picker on/off. On entry, picks
  //                    the most-recent assistant entry with text.
  //                    No-op (picker stays null) if the session has
  //                    no assistant entries with text yet.
  // pickerMove       — direction is +1 (Down → newer) or -1 (Up →
  //                    older). Walks the assistantUuidsWithText
  //                    list; clamps at the ends rather than wrapping
  //                    (less surprising, matches macOS list pickers).
  // pickerConfirm    — copies the selected entry's text to clipboard,
  //                    shows a pane toast, clears the picker.
  // pickerCancel     — clears the picker without copying.
  const pickerEnter = useCallback((sessionId: SessionId) => {
    setRuntimes(prev => {
      const current = prev[sessionId] ?? emptyRuntime()
      if (current.assistantPicker) {
        return {
          ...prev,
          [sessionId]: { ...current, assistantPicker: null },
        }
      }
      const uuids = assistantUuidsWithText(current.entries)
      if (uuids.length === 0) return prev
      return {
        ...prev,
        [sessionId]: {
          ...current,
          assistantPicker: { selectedUuid: uuids[uuids.length - 1] },
        },
      }
    })
  }, [])

  const pickerMove = useCallback(
    (sessionId: SessionId, direction: -1 | 1) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const picker = current.assistantPicker
        if (!picker) return prev
        const uuids = assistantUuidsWithText(current.entries)
        if (uuids.length === 0) return prev
        const idx = uuids.indexOf(picker.selectedUuid)
        if (idx === -1) {
          // Selected uuid disappeared mid-flight — snap to the
          // newest available so the user keeps a stable reference.
          return {
            ...prev,
            [sessionId]: {
              ...current,
              assistantPicker: { selectedUuid: uuids[uuids.length - 1] },
            },
          }
        }
        const nextIdx = Math.max(0, Math.min(uuids.length - 1, idx + direction))
        if (nextIdx === idx) return prev
        return {
          ...prev,
          [sessionId]: {
            ...current,
            assistantPicker: { selectedUuid: uuids[nextIdx] },
          },
        }
      })
    },
    [],
  )

  const pickerCancel = useCallback((sessionId: SessionId) => {
    setRuntimes(prev => {
      const c = prev[sessionId]
      if (!c?.assistantPicker) return prev
      return { ...prev, [sessionId]: { ...c, assistantPicker: null } }
    })
  }, [])

  const pickerConfirm = useCallback(
    async (sessionId: SessionId) => {
      const current = latestRuntimesRef.current[sessionId]
      if (!current?.assistantPicker) return
      const text = extractAssistantByUuid(
        current.entries,
        current.assistantPicker.selectedUuid,
      )
      // Clear the picker first so the UI returns to normal even if
      // the clipboard write fails (rare — only with a permission
      // denial, which we surface via toast).
      setRuntimes(prev => {
        const c = prev[sessionId]
        if (!c) return prev
        return { ...prev, [sessionId]: { ...c, assistantPicker: null } }
      })
      if (!text) {
        showPaneToast(sessionId, 'Nothing to copy')
        return
      }
      try {
        await navigator.clipboard.writeText(text)
        showPaneToast(sessionId, 'Copied assistant message')
      } catch {
        showPaneToast(sessionId, 'Clipboard write failed')
      }
    },
    [showPaneToast],
  )

  // ---- Persist to disk on every mutation (debounced) ----
  //
  // The save is extracted into a stable helper so it can be called both
  // from the debounce timer AND from the beforeunload flush below. We
  // keep a ref to the latest state so the beforeunload handler (which
  // can't close over React state) always serializes the freshest version.
  const latestStateRef = useRef(state)
  latestStateRef.current = state

  const flushSave = useCallback(() => {
    const s = latestStateRef.current
    // Collect non-empty drafts so in-progress prompts survive crashes.
    const drafts: Record<SessionId, string> = {}
    for (const [id, rt] of Object.entries(latestRuntimesRef.current)) {
      if (rt.draftInput) drafts[id] = rt.draftInput
    }
    const persisted: PersistedWorkspace = {
      tabs: s.tabs.map(t => ({
        id: t.id,
        title: t.title,
        focusedSessionId: t.focusedSessionId,
        root: t.root,
      })),
      activeTabId: s.activeTabId,
      sessions: s.sessions,
      buried: s.buried,
      tileTabs: latestTileTabsRef.current,
      drafts: Object.keys(drafts).length > 0 ? drafts : undefined,
    }
    const json = JSON.stringify({ workspace: persisted }, null, 2)
    void window.api.saveWorkspace(json).catch(err => {
      // eslint-disable-next-line no-console
      console.warn('[workspace] save failed:', err)
    })
  }, [])

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(flushSave, 400)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [state, draftVersion, flushSave])

  // ---- Flush on window close ----
  //
  // The debounced save has a 400ms window where a mutation hasn't been
  // written yet. If the user quits the app during that window, the
  // latest state is lost — tabs vanish, sessions can't resume.
  //
  // Fix: listen for `beforeunload` (fires synchronously before the
  // renderer is torn down) and flush immediately. The IPC invoke is
  // async but Electron's main process receives the message before the
  // window actually closes — the write lands. This is the same pattern
  // VS Code uses for its workspace state.
  useEffect(() => {
    const onBeforeUnload = () => {
      // Cancel the debounced timer so we don't double-save.
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      flushSave()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [flushSave])

  // ---- Load on first mount ----
  //
  // If there's persisted state, respawn every session in its saved
  // cwd (minting fresh sessionIds because main process ids are
  // ephemeral) and remap the tree to use the new ids. If there's no
  // saved state, spawn one default session in the default cwd.
  const bootRef = useRef(false)
  useEffect(() => {
    if (bootRef.current) return
    bootRef.current = true
    void (async () => {
      const json = await window.api.loadWorkspace()
      if (!json) {
        // Fresh install — create one default tab.
        const cwd = await window.api.defaultCwd()
        try {
          await newTab(cwd)
        } catch (err) {
          console.warn('[workspace] initial session spawn failed:', err)
        }
        return
      }
      try {
        // Single-user dev app — no schema versioning. If the load
        // fails for any reason (corrupt JSON, unexpected shape,
        // spawn error during rehydrate) we fall through to the
        // catch below and start fresh. No migrations, no version
        // gates.
        const parsed = JSON.parse(json) as { workspace: PersistedWorkspace }
        await rehydrate(parsed.workspace)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[workspace] load failed, starting fresh:', err)
        const cwd = await window.api.defaultCwd()
        try {
          await newTab(cwd)
        } catch (spawnErr) {
          console.warn('[workspace] fallback session spawn failed:', spawnErr)
        }
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Remap a persisted tree by replacing every sessionId with a freshly
   * spawned one (spawn happens as we walk). Returns the remapped tree
   * plus the old→new id mapping.
   *
   * Resume semantics: if the persisted SessionMeta carries a
   * `providerSessionId`, we pass it to the spawn call as `resumeSessionId`
   * so claude boots with `--resume <uuid>` and the full conversation
   * history — tool calls, transcript, queue state, the lot — comes
   * back. The cc-shell SessionId we mint here is a fresh routing
   * key; CC's own session UUID is the thing we care about preserving.
   *
   * The providerSessionId is ALSO threaded into freshSessions[newId] so
   * the runtime meta after rehydrate matches pre-reload state and
   * the next save cycle writes it straight back. Without this, the
   * first save after a resume would drop providerSessionId and the NEXT
   * reload would lose context again.
   *
   * Failure modes:
   *   - File missing / corrupted → CC will exit with a non-zero code
   *     shortly after spawn. Surfaces via the exit event as "exited"
   *     in the pane status strip. Not retried automatically — the
   *     user can close the pane and open a fresh one.
   *   - File locked by another process (rare) → same as above.
   *   - Spawn itself throws (IPC failure) → caught below and logged;
   *     the pane is simply missing from the rehydrated tree.
  */
  const rehydrate = useCallback(async (persisted: PersistedWorkspace) => {
    const idMap = new Map<SessionId, SessionId>()
    const freshSessions: Record<SessionId, SessionMeta> = {}

    const remapNode = (n: TileNode): TileNode => {
      if (n.type === 'leaf') {
        const mapped = idMap.get(n.sessionId)
        return mapped
          ? { type: 'leaf', sessionId: mapped }
          : n // shouldn't happen, but fall through rather than crash
      }
      return { ...n, a: remapNode(n.a), b: remapNode(n.b) }
    }

    const sanitizeRemappedNode = (n: TileNode): TileNode | null => {
      if (n.type === 'leaf') {
        return freshSessions[n.sessionId] != null ? n : null
      }
      const a = sanitizeRemappedNode(n.a)
      const b = sanitizeRemappedNode(n.b)
      if (!a && !b) return null
      if (!a) return b
      if (!b) return a
      return { ...n, a, b }
    }

    const buildRemappedTabs = (): Tab[] =>
      persisted.tabs
        .map(t => {
          const remappedRoot = sanitizeRemappedNode(remapNode(t.root))
          if (!remappedRoot) return null
          const leaves = collectLeaves(remappedRoot)
          if (leaves.length === 0) return null
          const focused = idMap.get(t.focusedSessionId) ?? leaves[0]
          return {
            id: t.id,
            title: t.title,
            root: remappedRoot,
            focusedSessionId: focused,
          } satisfies Tab
        })
        .filter((t): t is Tab => t !== null)

    const buildRemappedBuried = (): BuriedPaneRecord[] =>
      (persisted.buried ?? [])
        .map(entry => {
          const mappedSessionId = idMap.get(entry.sessionId)
          if (!mappedSessionId) return null
          return {
            ...entry,
            id: mappedSessionId,
            sessionId: mappedSessionId,
            siblingLeafId: entry.siblingLeafId
              ? (idMap.get(entry.siblingLeafId) ?? entry.siblingLeafId)
              : undefined,
          } satisfies BuriedPaneRecord
        })
        .filter((entry): entry is BuriedPaneRecord => entry !== null)

    const buildRemappedTileTabs = (tabs: Tab[]): TileTabsState | null => {
      const persistedTileTabs = persisted.tileTabs
      if (!persistedTileTabs) return null
      const validTabIds = persistedTileTabs.tabIds.filter(id =>
        tabs.some(tab => tab.id === id),
      )
      return sanitizeTileTabsState({
        ...persistedTileTabs,
        tabIds: validTabIds,
      })
    }

    const commitRehydratedState = () => {
      const newTabs = buildRemappedTabs()
      if (newTabs.length === 0) return false

      const restoredTileTabs = buildRemappedTileTabs(newTabs)
      const activeTabId = restoredTileTabs?.focusedTabId
        ?? newTabs.find(t => t.id === persisted.activeTabId)?.id
        ?? newTabs[0].id

      setState({
        tabs: newTabs,
        activeTabId,
        sessions: { ...freshSessions },
        buried: buildRemappedBuried(),
      })
      setTileTabs(restoredTileTabs)
      // WHY commit runtimes incrementally during rehydrate:
      //
      // Boot used to await every respawn before publishing *any* restored
      // tabs. One slow / wedged session kept `tabs: []`, so after restart the
      // user only saw the `+` button even though workspace.json contained a
      // full layout. We now publish whatever subset has already rehydrated so
      // the shell surfaces real tabs immediately and fills in the remaining
      // panes as their sessions come back.
      //
      // We still merge with prev because resume-side transcript events can
      // arrive synchronously inside `session.start()` before spawnSession()
      // resolves. Replacing the runtime object here would clobber those early
      // entries and make restored panes open blank.
      setRuntimes(prev => {
        const out: Record<SessionId, SessionRuntime> = {}
        for (const [oldId, newId] of idMap.entries()) {
          const existing = prev[newId]
          const base = existing ?? emptyRuntime()
          const draft = persisted.drafts?.[oldId]
          out[newId] = {
            ...base,
            ...(draft && !base.draftInput ? { draftInput: draft } : {}),
            hasOlderHistory: Boolean(freshSessions[newId]?.providerSessionId),
          }
        }
        for (const id of Object.keys(freshSessions)) {
          if (out[id]) continue
          const existing = prev[id]
          out[id] = {
            ...(existing ?? emptyRuntime()),
            hasOlderHistory: Boolean(freshSessions[id]?.providerSessionId),
          }
        }
        return out
      })
      return true
    }

    // Spawn all sessions concurrently instead of serially. A single slow
    // respawn must not block the entire tab strip from coming back.
    await Promise.all(
      Object.entries(persisted.sessions).map(async ([oldId, meta]) => {
        try {
          const kind: SessionKind = meta.kind ?? 'claude'
          // For terminal sessions with a persisted tmuxName, pass it as
          // recoverTmuxName so main re-attaches the alive tmux session
          // (or falls back to fresh spawn if it died). Agents ignore
          // recoverTmuxName at the main side; safe to omit for them.
          const { sessionId: newId, tmuxName: nextTmuxName } = await window.api.spawnSession({
            kind,
            cwd: meta.cwd,
            resumeSessionId: kind !== 'terminal' ? meta.providerSessionId : undefined,
            dangerousMode: kind !== 'terminal' ? dangerousAgentsRef.current : undefined,
            useProxy: kind !== 'terminal' ? useProxyStreamingRef.current : undefined,
            recoverTmuxName: kind === 'terminal' ? meta.tmuxName : undefined,
          })
          idMap.set(oldId, newId)
          // Carry the full meta forward — kind + providerSessionId +
          // tmuxName — so the next save cycle doesn't drop these and
          // cause the session to degrade on the NEXT reload. tmuxName
          // is replaced with whatever main reported (recovered name
          // when alive, fresh name when respawned).
          freshSessions[newId] = {
            ...meta,
            ...(nextTmuxName ? { tmuxName: nextTmuxName } : {}),
          }
          commitRehydratedState()
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[workspace] failed to respawn ${meta.cwd}:`, err)
        }
      }),
    )

    if (!commitRehydratedState()) {
      const cwd = await window.api.defaultCwd()
      await newTab(cwd)
    }
  }, [newTab, setTileTabs])

  // ---- Action: undo close ----
  //
  // Pops the most recent entry from the undo stack and restores it.
  // For panes: finds the surviving sibling in the current tree by its
  // anchor leaf, re-wraps it in a split with the restored session on
  // the correct side, and respawns the session (with --resume for
  // Claude sessions so the conversation comes back).
  //
  // For tabs: respawns every session in the tab, remaps the session
  // ids in the tree (since the new spawn produces new ids), and
  // re-inserts the tab at its original index (clamped to bounds).
  const undoClose = useCallback(async () => {
    const entry = undoStackRef.current.pop()
    if (!entry) return

    if (entry.type === 'pane') {
      // Find which tab the sibling leaf is in now.
      const targetTab = state.tabs.find(t =>
        collectLeaves(t.root).includes(entry.siblingLeafId),
      )
      if (!targetTab) return // sibling was also closed — stale undo

      // Respawn the session.
      //   - Claude/Codex with providerSessionId → pass --resume so
      //     the conversation history replays via JSONL.
      //   - Terminal with tmuxName → pass recoverTmuxName so the
      //     same tmux session is re-attached, preserving scrollback
      //     and any running process. Without this, "undo close" on
      //     a terminal would respawn an empty shell — defeating the
      //     point of having a tmux backing.
      const meta = entry.sessionMeta
      const newSessionId = await spawn(meta.cwd, {
        kind: meta.kind ?? 'claude',
        resumeSessionId: meta.providerSessionId,
        recoverTmuxName: meta.kind === 'terminal' ? meta.tmuxName : undefined,
      })

      setState(prev => {
        const tabs = prev.tabs.map(t => {
          if (t.id !== targetTab.id) return t
          const newRoot = reinsertPane(
            t.root,
            entry.siblingLeafId,
            newSessionId,
            entry.direction,
            entry.ratio,
            entry.side,
          )
          if (!newRoot) return t // anchor not found — bail
          return {
            ...t,
            root: newRoot,
            focusedSessionId: newSessionId,
          }
        })
        return { ...prev, tabs }
      })
    } else {
      // Tab undo: respawn every session and remap the tree.
      const idMap = new Map<SessionId, SessionId>()
      const freshSessions: Record<SessionId, SessionMeta> = {}

      for (const [oldId, meta] of Object.entries(entry.sessionMetas)) {
        try {
          const kind: SessionKind = meta.kind ?? 'claude'
          // Same per-kind recover hint as the pane-undo branch above:
          // tmuxName for terminals, providerSessionId for agents.
          const newId = await spawn(meta.cwd, {
            kind,
            resumeSessionId: kind !== 'terminal' ? meta.providerSessionId : undefined,
            recoverTmuxName: kind === 'terminal' ? meta.tmuxName : undefined,
          })
          idMap.set(oldId, newId)
          freshSessions[newId] = meta
        } catch {
          // If one session fails to spawn, skip it — restore what we can.
        }
      }

      if (idMap.size === 0) return // nothing survived

      const remapNode = (n: TileNode): TileNode => {
        if (n.type === 'leaf') {
          const mapped = idMap.get(n.sessionId)
          return mapped ? { type: 'leaf', sessionId: mapped } : n
        }
        return { ...n, a: remapNode(n.a), b: remapNode(n.b) }
      }

      const restoredRoot = remapNode(entry.tab.root)
      const leaves = collectLeaves(restoredRoot)
      if (leaves.length === 0) return

      const restoredFocused =
        idMap.get(entry.tab.focusedSessionId) ?? leaves[0]
      const restoredTab: Tab = {
        id: crypto.randomUUID(),
        title: entry.tab.title,
        root: restoredRoot,
        focusedSessionId: restoredFocused,
      }

      setState(prev => {
        const insertIdx = Math.min(entry.tabIndex, prev.tabs.length)
        const tabs = [...prev.tabs]
        tabs.splice(insertIdx, 0, restoredTab)
        return {
          ...prev,
          tabs,
          activeTabId: restoredTab.id,
        }
      })
    }
  }, [spawn, state.tabs])

  // ---- Action: normalize layout (soft) ----
  //
  // Keep the existing tree structure but set every split ratio to 0.5.
  // Equalizes spacing without rearranging panes — if you have three
  // vertical panes on the left and one on the right, they stay that
  // way but all dividers move to the midpoint.
  const normalizeLayout = useCallback(() => {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t =>
        t.id === prev.activeTabId
          ? { ...t, root: equalizeRatios(t.root) }
          : t,
      ),
    }))
  }, [])

  // ---- Action: hard normalize layout ----
  //
  // Flatten the tree and rebuild as a balanced grid where every pane
  // gets equal space. Changes the arrangement — all panes end up in
  // a rows × cols grid. No sessions are spawned or killed.
  const hardNormalizeLayout = useCallback(() => {
    setState(prev => {
      const tab = prev.tabs.find(t => t.id === prev.activeTabId)
      if (!tab) return prev
      const leaves = collectLeaves(tab.root)
      if (leaves.length <= 1) return prev
      const newRoot = normalizeTree(leaves)
      return {
        ...prev,
        tabs: prev.tabs.map(t =>
          t.id === prev.activeTabId ? { ...t, root: newRoot } : t,
        ),
      }
    })
  }, [])

  // ---- Action: rotate layout ----
  //
  // Flip every split direction in the active tab's tree: vertical
  // becomes horizontal and vice versa. Turns rows into columns.
  const rotateLayout = useCallback(() => {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t =>
        t.id === prev.activeTabId
          ? { ...t, root: rotateTree(t.root) }
          : t,
      ),
    }))
  }, [])

  /** Peek at the undo stack length — used by the command palette to
   *  show/hide the "Undo Close" command. */
  const undoCloseCount = undoStackRef.current.length

  const activeTab = useMemo(
    () => state.tabs.find(t => t.id === state.activeTabId) ?? null,
    [state.activeTabId, state.tabs],
  )

  useEffect(() => {
    if (!spotlight) return
    const tab = state.tabs.find(t => t.id === spotlight.tabId)
    if (!tab) {
      setSpotlight(null)
      return
    }
    const leaves = collectLeaves(tab.root)
    if (leaves.length === 0) {
      setSpotlight(null)
      return
    }
    if (!leaves.includes(spotlight.focusedSessionId)) {
      setSpotlight(prev => (prev ? { ...prev, focusedSessionId: leaves[0] } : prev))
    }
  }, [spotlight, state.tabs])

  // Same invalidation rule for ReaderMode — if the tab disappears or
  // its leaves change so the focused session no longer exists, drop
  // out of Reader cleanly. Without this, closing the last pane in
  // the tab while Reader is open would leave a dangling focused
  // sessionId and a blank screen.
  useEffect(() => {
    if (!readerMode) return
    const tab = state.tabs.find(t => t.id === readerMode.tabId)
    if (!tab) {
      setReaderMode(null)
      return
    }
    const leaves = collectLeaves(tab.root)
    if (leaves.length === 0) {
      setReaderMode(null)
      return
    }
    if (!leaves.includes(readerMode.focusedSessionId)) {
      setReaderMode(prev => (prev ? { ...prev, focusedSessionId: leaves[0] } : prev))
    }
  }, [readerMode, state.tabs])

  // Picker invalidation. If the selected uuid is no longer present in
  // a session's entries (entries cleared, conversation reset, etc.),
  // cancel the picker. Without this the outline silently disappears
  // (matching DOM node is gone) but the picker state lingers and
  // keeps capturing keystrokes.
  useEffect(() => {
    for (const [sessionId, runtime] of Object.entries(runtimes)) {
      if (!runtime.assistantPicker) continue
      const uuids = assistantUuidsWithText(runtime.entries)
      if (!uuids.includes(runtime.assistantPicker.selectedUuid)) {
        pickerCancel(sessionId)
      }
    }
  }, [runtimes, pickerCancel])

  useEffect(() => {
    if (!tileTabs) return
    const nextTileTabs = sanitizeTileTabsState(tileTabs)
    if (!nextTileTabs) {
      setTileTabs(null)
      return
    }
    const validTabIds = nextTileTabs.tabIds.filter(id => state.tabs.some(t => t.id === id))
    const sanitized = sanitizeTileTabsState({
      ...nextTileTabs,
      tabIds: validTabIds,
    })
    if (!sanitized) {
      setTileTabs(null)
      return
    }
    if (
      sanitized.tabIds.length !== tileTabs.tabIds.length ||
      sanitized.focusedTabId !== tileTabs.focusedTabId ||
      sanitized.direction !== tileTabs.direction ||
      !ratiosEqual(sanitized.ratios, tileTabs.ratios)
    ) {
      setTileTabs(sanitized)
    }
  }, [tileTabs, state.tabs])

  // ---- Status mode: color-coded pane headers ----
  const statusMode = useAppStore(store => store.workspaceStatusMode)
  const setStatusMode = useAppStore(store => store.setWorkspaceStatusMode)
  const toggleStatusMode = useCallback(() => {
    setStatusMode(prev => !prev)
  }, [])

  return {
    state,
    runtimes,
    activeTab,
    spotlight,
    tileTabs,
    readerMode,
    toggleReaderMode,
    setReaderModeSession,
    latestScreenRef,
    getRuntime,
    statusMode,
    toggleStatusMode,
    // actions
    newTab,
    closeTab,
    spawn,
    killSession,
    splitFocused,
    startNewAgentPlacement,
    commitNewAgentPlacement,
    closeFocused,
    closeSession,
    requestBuryFocused,
    buryFocused,
    reviveBuried,
    focusSession,
    focusSessionInTab,
    navigate,
    activateTab,
    activateTabByIndex,
    nextTab,
    prevTab,
    resizeFocused,
    resizeFocusedDirectional,
    setSplitRatio,
    setSplitRatioInTab,
    setStreamingBaseline,
    appendFeedDebug,
    addOptimisticCodexUserEntry,
    removeOptimisticCodexUserEntry,
    setDraftInput,
    setDraftImages,
    loadOlderHistory,
    showPaneToast,
    undoClose,
    undoCloseCount,
    normalizeLayout,
    hardNormalizeLayout,
    rotateLayout,
    replaceSession,
    reloadFocusedAgent,
    switchFocusedProvider,
    reloadAgentSessions,
    toggleSpotlight,
    setSpotlightSession,
    openTileTabs,
    closeTileTabs,
    focusTiledTab,
    focusTiledTabByIndex,
    resizeFocusedTiledTab,
    resizeTiledTabByIndex,
    toggleTailMode,
    scrollFocusedToLatest,
    pickerEnter,
    pickerMove,
    pickerConfirm,
    pickerCancel,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function titleFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

function equalRatios(count: number): number[] {
  if (count <= 0) return []
  return Array.from({ length: count }, () => 1 / count)
}

function sanitizeTileTabsState(tileTabs: TileTabsState): TileTabsState | null {
  if (tileTabs.tabIds.length < 2) return null
  const tabIds = Array.from(new Set(tileTabs.tabIds))
  if (tabIds.length < 2) return null
  const focusedTabId = tabIds.includes(tileTabs.focusedTabId)
    ? tileTabs.focusedTabId
    : tabIds[0]
  const ratios = tileTabs.ratios.length === tabIds.length
    ? normalizeRatios(tileTabs.ratios)
    : equalRatios(tabIds.length)
  return {
    ...tileTabs,
    tabIds,
    focusedTabId,
    ratios,
  }
}

function normalizeRatios(ratios: number[]): number[] {
  if (ratios.length === 0) return []
  const total = ratios.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return equalRatios(ratios.length)
  return ratios.map(value => value / total)
}

function ratiosEqual(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > 0.0001) return false
  }
  return true
}

/**
 * Cheap structural comparison for SlashPickerState. The picker object
 * itself is always fresh (parsed anew from each terminal snapshot in
 * main), so reference equality never holds — we have to look at the
 * visible flag, the item count, and the per-item id + selected bit.
 * IDs are short strings, items cap at ~15, so this runs in microseconds
 * and is still vastly cheaper than letting a no-op screen frame
 * propagate into a React render.
 */
function pickerEqual(
  a: SlashPickerState,
  b: SlashPickerState,
): boolean {
  if (a.visible !== b.visible) return false
  if (a.items.length !== b.items.length) return false
  for (let i = 0; i < a.items.length; i++) {
    const x = a.items[i]
    const y = b.items[i]
    if (x.id !== y.id || x.selected !== y.selected) return false
  }
  return true
}

function setRatioBetween(
  node: TileNode,
  aSession: SessionId,
  bSession: SessionId,
  ratio: number,
): TileNode {
  if (node.type === 'leaf') return node
  const leavesA = collectLeaves(node.a)
  const leavesB = collectLeaves(node.b)
  if (leavesA.includes(aSession) && leavesB.includes(bSession)) {
    return { ...node, ratio: Math.min(0.9, Math.max(0.1, ratio)) }
  }
  return {
    ...node,
    a: setRatioBetween(node.a, aSession, bSession, ratio),
    b: setRatioBetween(node.b, aSession, bSession, ratio),
  }
}

// Silence unused-var warning for RATIO_DEFAULT re-export path — used in treeOps.
void RATIO_DEFAULT
// Silence for useCallback imports we want explicit.
export { collectLeaves }
export type {
  PickerItem,
  QueuedMessage,
  ReaderModeState,
  SessionRuntime,
  SlashPickerState,
  SpotlightState,
  TileTabsState,
} from './workspaceState'
