import { AskUserQuestionAnsweredRow } from '@renderer/features/feed/ui/rows/AskUserQuestionAnsweredRow'
import { memo, useContext } from 'react'

import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import type {
  ContentBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '@shared/types/transcript'
import { detectGitIntent } from '@shared/git/gitDetect'

import { useAppStore } from '@renderer/app-state/hooks'
import { GitCardRow } from '@renderer/features/git/ui/GitRows'

import { extractToolCommand, toolResultText } from '@renderer/features/feed/lib/helpers'
import {
  ProviderContext,
  ToolResultIndexContext,
  ToolUseIndexContext,
} from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { TextProse } from '@renderer/features/feed/ui/markdown'

import { ImageBlockRow } from '@renderer/features/feed/ui/rows/ImageBlockRow'
import { UserBand } from '@renderer/features/feed/ui/rows/primitives'
import { ToolResultRow } from '@renderer/features/feed/ui/rows/ToolResultRow'
import { ToolUseRow } from '@renderer/features/feed/ui/rows/ToolUseRow'
import { isAgentSpawnToolName } from '@providers/registry.renderer.capabilities'
import { JsonToolRow } from '@providers/shared/renderer/rows/JsonToolRow'
import { TaskSubagentRow } from '@renderer/features/feed/ui/rows/TaskSubagentRow'
import {
  isWorkflowViewToolName,
  parseWorkflowToolResult,
} from '@renderer/features/workflows/model/workflowTool'
import type { RenderOutcome, RenderShapePlane } from '@shared/types/renderShapes'
import { observeRenderShape } from '@renderer/features/feed/evidence/observer'
import { useRenderShapeCapture } from '@renderer/features/feed/evidence/RenderShapeCaptureContext'
import {
  absorbedOutcome,
  GENERIC_OUTCOME,
  specializedOutcome,
  unknownOutcome,
} from '@renderer/features/feed/evidence/outcome'

/* ---------- Block dispatcher ---------- */

// Memoized: blocks inside an assistant/user message are stable objects —
// the entry never mutates, so block identity is a perfect memo key.
//
// This is the main per-block dispatcher. ConversationRow hands it a
// ContentBlock and a role, and Block picks the right renderer:
//   - text under role='user' → UserBand + TextProse
//   - text under role='assistant' → TextProse with `⏺` marker
//   - thinking → collapsed <details> if non-empty, else nothing
//   - image → ImageBlockRow
//   - tool_use → provider-specific renderer (Claude: Edit/MultiEdit/
//     Write/TodoWrite rich rows; Codex: CodexToolRow; everything else:
//     generic ToolUseRow). Plus the git-widget interception.
//   - tool_result → provider-specific result renderer, with the git
//     widget suppression mirrored here.
// #442 finding-21: the git-widget card renders for a shell tool_use, and the
// paired tool_result must be suppressed so the raw output doesn't duplicate
// below the card. The two checks drifted — the tool_use branch recognized
// opencode's lowercase 'bash' twin but the tool_result suppression did not, so
// an opencode git command painted BOTH the card and the raw result. Hoisting
// the name set into one predicate used by both branches makes that drift
// impossible: whatever the widget renders for, the result suppresses for.
function isGitWidgetShellTool(name: string | undefined): boolean {
  return name === 'Bash' || name === 'exec_command' || name === 'bash'
}

export const Block = memo(function Block({
  block,
  role,
}: {
  block: ContentBlock
  role: 'user' | 'assistant'
}) {
  const currentProvider = useContext(ProviderContext)
  const toolUseIndex = useContext(ToolUseIndexContext)
  const toolResultIndex = useContext(ToolResultIndexContext)
  const customRendering = useAppStore(state => state.settings.customRendering)
  const capture = useRenderShapeCapture()
  // Shape sighting at the exact paint-decision point (Phase 2, PR #555).
  // A module-state side effect during render, on purpose: it never touches
  // React state (no re-render), it is inert unless capture is armed (one
  // Map.get), and StrictMode double-renders only bump a dedup counter — the
  // documented approximate-count contract in observer.ts. Committed blocks
  // are durable transcript evidence, hence lifecycle 'durable'.
  const sight = (plane: RenderShapePlane, payload: unknown, outcome: RenderOutcome): void => {
    if (!capture) return
    observeRenderShape({
      sessionId: capture.sessionId,
      provider: capture.provider,
      plane,
      lifecycle: 'durable',
      eventType: block.type,
      payload,
      outcome,
    })
  }
  switch (block.type) {
    case 'text': {
      // Only text blocks under a user role represent an actual user
      // prompt. A sibling tool_result block in the same message is
      // NOT a user prompt (it's tool output), and must not get the
      // highlight — that's why the band lives here and not around
      // the whole ConversationRow.
      const row = (
        <MarkerRow marker={role === 'user' ? '❯' : '⏺'}>
          <TextProse text={(block as { text: string }).text} />
        </MarkerRow>
      )
      return role === 'user' ? <UserBand>{row}</UserBand> : row
    }
    case 'thinking': {
      // Persisted thinking block. Anthropic strips the plaintext from
      // the final message (only `signature` ciphertext survives), so
      // text is ALMOST ALWAYS empty in committed transcripts. Old
      // behaviour was to render a placeholder `∴ Thinking` row; now
      // we render nothing and let the WorkIndicator (while live) and
      // the absence of content (after the fact) speak for themselves.
      //
      // Non-empty thinking on a committed block does still exist
      // (older sessions, non-Opus-4 models, synthetic entries). Keep
      // the expandable surface for those — aligned with the live
      // branch above, `<details>` closed by default.
      //
      // See docs/superpowers/plans/2026-04-18-thinking-indicator-rework.md.
      const text = (block as { thinking?: string }).thinking ?? ''
      if (!text) return null
      return (
        <MarkerRow marker="⏺" tone="muted">
          <details className="text-muted text-[12px]">
            <summary className="cursor-pointer select-none italic">
              ∴ Thinking
              <span className="ml-2 not-italic text-ink-dim opacity-70">
                (click to expand)
              </span>
            </summary>
            <div className="mt-1.5 text-ink-dim opacity-80">
              <TextProse text={text} />
            </div>
          </details>
        </MarkerRow>
      )
    }
    case 'image': {
      return <ImageBlockRow block={block} role={role} />
    }
    case 'tool_use': {
      // Dispatch tool_use blocks to provider-specific row renderers.
      // Claude has rich renderers for Edit/MultiEdit/Write/TodoWrite;
      // codex uses a generic CodexToolRow for now (will grow per-tool
      // renderers as we learn codex's tool shapes from recordings).
      const tu = block as ToolUseBlock

      // Custom rendering: intercept shell/bash invocations that are
      // recognized git commands and render them as a purpose-built
      // widget. Claude's tool name is 'Bash'; Codex's is
      // 'exec_command' (the function-call name). Both carry the
      // command string via extractToolCommand.
      //
      // We render on the tool_use row. The paired result block is
      // looked up from the reverse index; if not yet present (result
      // hasn't arrived), the widget shows a "running…" placeholder
      // sourced purely from the command. The companion tool_result
      // block is suppressed below so the widget is the single
      // surface for this command.
      if (
        customRendering
        // 'bash' = opencode's lowercase twin (P3): same commands, same
        // git-widget value; the case difference is provider naming, not
        // semantics. Shared predicate keeps this in lockstep with the
        // tool_result suppression below.
        && isGitWidgetShellTool(tu.name)
      ) {
        const cmd = extractToolCommand(tu)
        const intent = detectGitIntent(cmd)
        if (intent && cmd) {
          const paired = toolResultIndex.get(tu.id)
          const output = paired ? toolResultText(paired) : ''
          sight('committed-tool-use', tu, specializedOutcome('shared.git-widget'))
          return <GitCardRow intent={intent} output={output} />
        }
      }

      if (isAgentSpawnToolName(tu.name)) {
        // Claude records subagent fanout as an `Agent` tool_use; Codex as a
        // `spawn_agent` function_call; Agent Code's owned MCP sessions as its
        // namespaced/bare `orchestration_create_agent` spellings (the 2026-06-21
        // blind spot — 73 tracked subAgents, zero cards). One shared
        // predicate routes them all through the fleet row before provider
        // dispatch, so the main process's SubAgentState (and P2b's
        // notification join) always has a card to land on.
        //
        // Phase 7 cutover: ask the current provider first. Claude's built-in
        // Agent and both provider spellings of Agent Code's orchestration MCP
        // now own their wire adapters and shared protocol view. A provider
        // decline keeps the proven native Codex legacy row alive until that
        // separate vocabulary has enough evidence for migration.
        const providerSpawnRow = getRendererProviderCapabilities(currentProvider).renderToolUse?.(tu)
        if (providerSpawnRow !== undefined) {
          sight('committed-tool-use', tu, specializedOutcome(`${currentProvider}.rows.dispatch`))
          return providerSpawnRow
        }
        sight('committed-tool-use', tu, specializedOutcome('shared.task-subagent'))
        return <TaskSubagentRow block={tu} />
      }

      if (tu.name === 'AskUserQuestion') {
        // Committed-plane question rendering (P2d): questions + verbatim
        // answer from the paired result. The LIVE picker (semantic plane)
        // owns the interaction; this is the durable record of it.
        sight('committed-tool-use', tu, specializedOutcome('shared.ask-user-question-answered'))
        return (
          <AskUserQuestionAnsweredRow
            block={tu}
            result={toolResultIndex.get(tu.id) ?? null}
          />
        )
      }

      const providerRow = getRendererProviderCapabilities(currentProvider).renderToolUse?.(tu)
      sight(
        'committed-tool-use',
        tu,
        providerRow !== undefined
          ? specializedOutcome(`${currentProvider}.rows.dispatch`)
          : GENERIC_OUTCOME,
      )
      // Shared fallback is the generic JSON tool row (residue plan P1):
      // it degrades to the old ToolUseRow look for headline-only inputs
      // (Bash keeps its 2-line cap) and gives MCP/orchestration payloads
      // a real rendering instead of a bare name over raw JSON.
      return providerRow !== undefined ? providerRow : <JsonToolRow block={tu} />
    }
    case 'tool_result': {
      const tr = block as ToolResultBlock
      // When custom rendering captured this result's source tool as
      // a git command, the tool_use row already rendered the widget
      // and consumed the output. Render nothing here so the output
      // doesn't duplicate below the card.
      if (customRendering) {
        const sourceTu = toolUseIndex.get(tr.tool_use_id)
        if (
          sourceTu
          && isGitWidgetShellTool(sourceTu.name)
          && detectGitIntent(extractToolCommand(sourceTu))
        ) {
          sight('committed-tool-result', tr, absorbedOutcome('shared.git-widget', 'output consumed by git widget on the tool_use row'))
          return null
        }
      }
      const sourceTool = toolUseIndex.get(tr.tool_use_id)
      if (
        isWorkflowViewToolName(sourceTool?.name) &&
        tr.is_error !== true &&
        parseWorkflowToolResult(tr) !== null
      ) {
        // The session shell consumes the launch envelope to add a view row below the composer.
        // Keep Main readable by suppressing the raw JSON result, but leave the generic tool-use row
        // in place as the durable transcript record that a workflow was launched or resumed.
        sight('committed-tool-result', tr, absorbedOutcome('workflow.session-view', 'launch envelope consumed by the session workflow view'))
        return null
      }
      // #442 finding-C2: an answered AskUserQuestion renders the picked answer
      // inside AskUserQuestionAnsweredRow on the tool_use row (it reads the
      // paired tool_result). Painting the tool_result again here shows the same
      // answer twice — the committed plane never had the suppression the live
      // semantic plane does. Suppress it so the answered-question card is the
      // single surface, mirroring the git-widget suppression just above.
      if (sourceTool?.name === 'AskUserQuestion') {
        sight('committed-tool-result', tr, absorbedOutcome('shared.ask-user-question-answered', 'answer painted on the tool_use row'))
        return null
      }
      const providerRow = getRendererProviderCapabilities(currentProvider).renderToolResult?.(tr, {
        sourceTool,
      })
      // Three-way outcome honesty (review finding: `null !== undefined`
      // recorded opencode's deliberate todowrite-echo suppression as
      // "specialized"): undefined = provider declined → generic fallback;
      // null = provider INTENTIONALLY suppressed → absorbed with the
      // dispatch named as owner; a node = specialized.
      sight(
        'committed-tool-result',
        tr,
        providerRow === undefined
          ? GENERIC_OUTCOME
          : providerRow === null
            ? absorbedOutcome(`${currentProvider}.rows.dispatch`, 'provider dispatch suppressed the result row')
            : specializedOutcome(`${currentProvider}.rows.dispatch`),
      )
      return providerRow !== undefined ? providerRow : <ToolResultRow block={tr} />
    }
    default:
      // An unknown committed block kind is exactly the class of shape the
      // capture system exists to catch — record it as an unknown outcome
      // (visible bounded fallback below), never a silent drop. Plane
      // 'transcript-entry' because a non-tool content block is normalized
      // transcript content, not a tool envelope.
      sight('transcript-entry', block, unknownOutcome('shared.block-type-label'))
      return (
        <MarkerRow marker="⏺" tone="muted">
          <div className="text-muted text-[11px] uppercase tracking-wider">
            {block.type}
          </div>
        </MarkerRow>
      )
  }
})
