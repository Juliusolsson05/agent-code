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
import { CommandCard } from '@renderer/features/feed/ui/artifacts/command'
import {
  DiffCard,
  fileEditFromCommitted,
} from '@renderer/features/feed/ui/artifacts/fileEdit'
import {
  ReadCard,
  readFromCommitted,
} from '@renderer/features/feed/ui/artifacts/fileRead'
import {
  FileWriteCard,
  fileWriteFromCommitted,
} from '@renderer/features/feed/ui/artifacts/fileWrite'
import { GenericToolCard } from '@renderer/features/feed/ui/artifacts/generic'
import {
  SlashCommandRow,
  isSlashCommandText,
} from '@renderer/features/feed/ui/artifacts/slashCommand'
import { TodoCard, todoFromCommitted } from '@renderer/features/feed/ui/artifacts/todo'
import { WebCard, webFromCommitted } from '@renderer/features/feed/ui/artifacts/web'
import {
  ImageGenCard,
  imageGenFromCommitted,
} from '@renderer/features/feed/ui/artifacts/imageGen'
import {
  commandFromCommitted,
  genericFromCommitted,
} from '@renderer/features/feed/ui/resolve/fromCommitted'
import {
  RESULT_CONSUMING_FAMILIES,
  isLegacyProviderClaimed,
  routeFamily,
} from '@renderer/features/feed/ui/resolve/registry'

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
  switch (block.type) {
    case 'text': {
      const text = (block as { text: string }).text
      // Slash-command surface: an invocation envelope or a
      // local-command-stdout record renders through SlashCommandRow
      // (name pill + output well) instead of painting the raw
      // <command-name>… tag soup into the prompt. Cheap string gate so
      // ordinary prompts never pay the regex cost.
      if (role === 'user' && isSlashCommandText(text)) {
        return <SlashCommandRow text={text} />
      }
      // Only text blocks under a user role represent an actual user
      // prompt. A sibling tool_result block in the same message is
      // NOT a user prompt (it's tool output), and must not get the
      // highlight — that's why the band lives here and not around
      // the whole ConversationRow.
      const row = (
        <MarkerRow marker={role === 'user' ? '❯' : '⏺'}>
          <TextProse text={text} />
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
          return <GitCardRow intent={intent} output={output} />
        }
      }

      if (isAgentSpawnToolName(tu.name)) {
        // Claude records subagent fanout as an `Agent` tool_use; Codex as a
        // `spawn_agent` function_call; MCP-orchestrated sessions as
        // `[mcp__<server>__]orchestration_create_agent` (the 2026-06-21
        // blind spot — 73 tracked subAgents, zero cards). One shared
        // predicate routes them all through the fleet row before provider
        // dispatch, so the main process's SubAgentState (and P2b's
        // notification join) always has a card to land on.
        return <TaskSubagentRow block={tu} />
      }

      if (tu.name === 'AskUserQuestion') {
        // Committed-plane question rendering (P2d): questions + verbatim
        // answer from the paired result. The LIVE picker (semantic plane)
        // owns the interaction; this is the durable record of it.
        return (
          <AskUserQuestionAnsweredRow
            block={tu}
            result={toolResultIndex.get(tu.id) ?? null}
          />
        )
      }

      // Command family — one card for Bash / exec_command / write_stdin /
      // local_shell_call, live-identical (spec §6). Routed AFTER the
      // git-intent interception above (git cards win for recognized git
      // commands) and after spawn/AskUserQuestion. The paired result is
      // consumed INTO the card (output + exit code); the tool_result
      // branch below suppresses it with the same routeFamily predicate —
      // the #442 lesson: whatever the card renders for, the result
      // suppresses for, one predicate, both branches.
      // Legacy provider claims (opencode read/todowrite) bypass the
      // family cards entirely — see isLegacyProviderClaimed's WHY.
      const legacyClaimed = isLegacyProviderClaimed(currentProvider, tu.name)
      const family = legacyClaimed ? null : routeFamily(currentProvider, tu.name)
      if (family === 'command') {
        const paired = toolResultIndex.get(tu.id) ?? null
        return <CommandCard vm={commandFromCommitted(tu, paired, currentProvider)} />
      }
      // generic + mcp go straight to the one fallback card (no provider
      // dispatch ever claimed these names — verified across all three
      // dispatch.tsx files at the time of the rewrite). The card
      // consumes the paired result (suppressed below via
      // RESULT_CONSUMING_FAMILIES), so live and committed MCP/unknown
      // tools finally render identically.
      if (family === 'generic' || family === 'mcp') {
        const paired = toolResultIndex.get(tu.id) ?? null
        return <GenericToolCard vm={genericFromCommitted(tu, paired, currentProvider)} />
      }
      if (family === 'file-edit') {
        const paired = toolResultIndex.get(tu.id) ?? null
        return (
          <DiffCard
            vm={fileEditFromCommitted(tu, paired, currentProvider)}
            toolName={tu.name}
          />
        )
      }
      if (family === 'file-write') {
        const paired = toolResultIndex.get(tu.id) ?? null
        return <FileWriteCard vm={fileWriteFromCommitted(tu, paired, currentProvider)} />
      }
      if (family === 'file-read') {
        const paired = toolResultIndex.get(tu.id) ?? null
        return <ReadCard vm={readFromCommitted(tu, paired, currentProvider)} />
      }
      if (family === 'todo') {
        const paired = toolResultIndex.get(tu.id) ?? null
        return (
          <TodoCard
            vm={todoFromCommitted(tu, paired, currentProvider)}
            label={tu.name}
          />
        )
      }
      if (family === 'web') {
        const paired = toolResultIndex.get(tu.id) ?? null
        return (
          <WebCard
            vm={webFromCommitted(tu, paired, currentProvider)}
            toolLabel={
              tu.name === 'tool_search' || tu.name === 'tool_search_call'
                ? 'Tool search'
                : undefined
            }
          />
        )
      }
      if (family === 'image-gen') {
        const paired = toolResultIndex.get(tu.id) ?? null
        return <ImageGenCard vm={imageGenFromCommitted(tu, paired, currentProvider)} />
      }

      const providerRow = getRendererProviderCapabilities(currentProvider).renderToolUse?.(tu)
      // Families whose dedicated card hasn't landed yet (file-read/
      // file-edit/file-write/todo/web — spec §8 migration state) keep
      // the legacy path: provider dispatch, else the old JSON tool row.
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
          return null
        }
      }
      const sourceTool = toolUseIndex.get(tr.tool_use_id)
      // Results consumed INTO a card on the tool_use row (command output,
      // generic/mcp result slots) — painting them again here duplicates
      // the output below the card. Same routing table as the tool_use
      // branch (the #442 lesson: one predicate, both branches).
      // RESULT_CONSUMING_FAMILIES is deliberately a subset of the landed
      // cards — suppressing a result whose card hasn't landed is data loss.
      if (
        sourceTool &&
        !isLegacyProviderClaimed(currentProvider, sourceTool.name) &&
        RESULT_CONSUMING_FAMILIES.has(routeFamily(currentProvider, sourceTool.name))
      ) {
        return null
      }
      // #442 finding-C2: an answered AskUserQuestion renders the picked answer
      // inside AskUserQuestionAnsweredRow on the tool_use row (it reads the
      // paired tool_result). Painting the tool_result again here shows the same
      // answer twice — the committed plane never had the suppression the live
      // semantic plane does. Suppress it so the answered-question card is the
      // single surface, mirroring the git-widget suppression just above.
      if (sourceTool?.name === 'AskUserQuestion') return null
      const providerRow = getRendererProviderCapabilities(currentProvider).renderToolResult?.(tr, {
        sourceTool,
      })
      return providerRow !== undefined ? providerRow : <ToolResultRow block={tr} />
    }
    default:
      return (
        <MarkerRow marker="⏺" tone="muted">
          <div className="text-muted text-[11px] uppercase tracking-wider">
            {block.type}
          </div>
        </MarkerRow>
      )
  }
})
