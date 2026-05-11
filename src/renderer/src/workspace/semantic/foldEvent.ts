import type { SessionKind } from '@renderer/workspace/types'
import type {
  SemanticLiveBlock,
  SemanticLiveTurn,
  SemanticRuntimeState,
} from '@renderer/workspace/workspaceState'

import {
  SEMANTIC_ERROR_CAP,
  SEMANTIC_HISTORY_CAP,
  SEMANTIC_LOG_CAP,
  deriveSemanticTaskSnapshot,
  emptySemanticLookupSnapshot,
  emptySemanticTaskSnapshot,
  flattenSemanticUsage,
  hasPendingSemanticTools,
  semanticHistoryRow,
  semanticToIndex,
} from '@renderer/workspace/semantic/helpers'
import { summarizeSemanticEvent } from '@renderer/workspace/semantic/summarize'

// ---------------------------------------------------------------------------
// foldSemanticEvent — the one-session-one-reducer contract
// ---------------------------------------------------------------------------
//
// WHY centralize semantic folding here instead of letting Feed,
// ReaderView, and the proxy debug UI each subscribe separately:
//
// The old architecture created three subtly different truths about the
// same live turn. Feed still derived structure from screen scraping,
// Reader kept a local semantic turn, and the debug panel had yet
// another reducer. That split is exactly how we ended up under-using
// the proxy stream: every UI surface only consumed the subset it
// happened to care about.
//
// The invariant now is "one session => one semantic reducer". Every
// semantic event, including late tool_result and connector/citation
// deltas, must flow through this fold before any UI reads it. If a
// future surface wants live model structure, it should select from
// `runtime.semantic`, not open its own transport subscription.

function eventTargetsDifferentTurn(
  ev: Record<string, unknown>,
  currentTurn: SemanticLiveTurn,
): boolean {
  // The active reducer turn is the UI source of truth. The bundle from
  // 2026-04-24 had a rollout turn (`019dbf35...`) open while proxy
  // block events from older `resp_*` flows were still being published.
  // Letting those block/text/completion events mutate the active turn
  // mixed proxy tool blocks into the rollout live row, which is one of
  // the concrete paths to a message appearing pinned at the bottom.
  //
  // We only reject events that carry an explicit, different turnId.
  // Some legacy semantic events are intentionally turnless and are
  // still reconciled by block index or tool call id; dropping those
  // here would trade the observed cross-turn corruption for missing
  // valid updates.
  return typeof ev.turnId === 'string' && ev.turnId !== currentTurn.turnId
}

export function foldSemanticEvent(
  state: SemanticRuntimeState,
  ev: Record<string, unknown>,
  sessionKind: SessionKind,
): SemanticRuntimeState {
  const now = Date.now()

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
      // Compaction-synthesis flag rides on `turn_started` only — it's
      // a turn-scope attribute set by ClaudeProxyAdapter from the
      // request-body sniff. Read once here; subsequent delta events
      // don't carry it. Defaults to false on every shape that isn't
      // an explicit boolean true (other source events, older proxy
      // adapters, codex/screen sources) so the placeholder UI fails
      // closed.
      const isCompactionSynthesis = ev.isCompactionSynthesis === true
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
          ...(isCompactionSynthesis ? { isCompactionSynthesis: true } : {}),
        }
      } else if (currentTurn.turnId === turnId) {
        // Same-turn refresh (source promotion / re-entry). Preserve
        // the existing flag rather than letting a flagless later
        // event clear it. The proxy is the only source that sets the
        // flag and it sets it on the very first turn_started.
        currentTurn = {
          ...currentTurn,
          source: typeof ev.source === 'string' ? ev.source : currentTurn.source,
          ...(isCompactionSynthesis ? { isCompactionSynthesis: true } : {}),
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
          ...(isCompactionSynthesis ? { isCompactionSynthesis: true } : {}),
        }
      }
      // Codex: mismatched turnId falls through — drop the event.
      break
    }
    case 'source_changed': {
      if (!currentTurn) break
      if (eventTargetsDifferentTurn(ev, currentTurn)) break
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
      if (eventTargetsDifferentTurn(ev, currentTurn)) break
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
      if (eventTargetsDifferentTurn(ev, currentTurn)) break
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
      if (eventTargetsDifferentTurn(ev, currentTurn)) break
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
      if (eventTargetsDifferentTurn(ev, currentTurn)) break
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
      if (eventTargetsDifferentTurn(ev, currentTurn)) break
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
      if (eventTargetsDifferentTurn(ev, currentTurn)) break
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
      if (eventTargetsDifferentTurn(ev, currentTurn)) break
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
      if (eventTargetsDifferentTurn(ev, currentTurn)) break
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
      if (eventTargetsDifferentTurn(ev, currentTurn)) break
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
      if (eventTargetsDifferentTurn(ev, currentTurn)) break
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
      if (eventTargetsDifferentTurn(ev, currentTurn)) break
      const usage = ev.usage as Record<string, unknown> | undefined
      if (!usage) break
      currentTurn = { ...currentTurn, usage: flattenSemanticUsage(usage) }
      break
    }
    case 'turn_stopped': {
      if (!currentTurn) break
      if (eventTargetsDifferentTurn(ev, currentTurn)) break
      currentTurn = {
        ...currentTurn,
        stopReason: typeof ev.stopReason === 'string' ? ev.stopReason : null,
        endedAt: now,
      }
      break
    }
    case 'turn_completed': {
      if (!currentTurn) break
      if (eventTargetsDifferentTurn(ev, currentTurn)) break
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

  // No-op short-circuit: every event used to allocate a new log array
  // and bump nextLogId at the top of the function, which meant the
  // returned state was never === state, even for events that changed
  // nothing (tool_result without a matching turn, usage_updated with
  // unchanged usage, etc.). That fired setRuntimes + the whole
  // reactive chain on every dead event — eight of them at bootstrap
  // alone per the 2026-04-20 evidence log.
  //
  // Reference equality on flows/currentTurn/history/errors is the
  // correct signal here because every branch that mutates those
  // fields rebinds the local to a new reference. If all four locals
  // still point at state.* AND finalCurrentTurn is identically
  // currentTurn (the derive skipped), this event was a no-op and we
  // return state unchanged. The log append for the event is skipped
  // too — dead events don't belong in the debug log either.
  if (
    flows === state.flows &&
    finalCurrentTurn === state.currentTurn &&
    history === state.history &&
    errors === state.errors
  ) {
    return state
  }

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
