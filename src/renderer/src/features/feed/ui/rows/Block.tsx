import { memo, useContext } from 'react'

import {
  EditRow,
  MultiEditRow,
  WriteRow,
  TodoRow,
} from '@providers/claude/renderer/rows/ClaudeRows'
import {
  CodexApplyPatchRow,
  CodexExecCommandRow,
  CodexToolRow,
  CodexToolResultRow,
  CodexWriteStdinRow,
} from '@providers/codex/renderer/rows/CodexRows'
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
        && (tu.name === 'Bash' || tu.name === 'exec_command')
      ) {
        const cmd = extractToolCommand(tu)
        const intent = detectGitIntent(cmd)
        if (intent && cmd) {
          const paired = toolResultIndex.get(tu.id)
          const output = paired ? toolResultText(paired) : ''
          return <GitCardRow intent={intent} output={output} />
        }
      }

      if (currentProvider === 'codex') {
        if (tu.name === 'apply_patch') {
          return <CodexApplyPatchRow block={tu} />
        }
        if (tu.name === 'exec_command') {
          return <CodexExecCommandRow block={tu} />
        }
        if (tu.name === 'write_stdin') {
          return <CodexWriteStdinRow block={tu} />
        }
        return <CodexToolRow block={tu} />
      }
      // Claude provider — dispatch by tool name.
      switch (tu.name) {
        case 'Edit':
          return <EditRow block={tu} />
        case 'MultiEdit':
          return <MultiEditRow block={tu} />
        case 'Write':
          return <WriteRow block={tu} />
        case 'TodoWrite':
          return <TodoRow block={tu} />
        default:
          return <ToolUseRow block={tu} />
      }
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
          && (sourceTu.name === 'Bash' || sourceTu.name === 'exec_command')
          && detectGitIntent(extractToolCommand(sourceTu))
        ) {
          return null
        }
      }
      if (currentProvider === 'codex') {
        return <CodexToolResultRow block={tr} />
      }
      return <ToolResultRow block={tr} />
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
