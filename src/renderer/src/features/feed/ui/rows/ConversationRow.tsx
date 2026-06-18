import { memo, type ReactNode } from 'react'

import type {
  ConversationEntry,
  ContentBlock,
  ToolUseBlock,
} from '@shared/types/transcript'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { TextProse } from '@renderer/features/feed/ui/markdown'

import { Block } from '@renderer/features/feed/ui/rows/Block'
import { SubagentGroupHeader } from '@renderer/features/feed/ui/rows/SubagentGroupHeader'
import { UserBand } from '@renderer/features/feed/ui/rows/primitives'

// True for a subagent-spawn block. Claude calls this tool `Agent`; Codex calls
// the same operation `spawn_agent`. Treating both names as the same semantic
// row keeps the grouping rule tied to user-visible behavior rather than a
// provider's wire vocabulary.
function isAgentBlock(block: ContentBlock): block is ToolUseBlock {
  return (
    block.type === 'tool_use' &&
    ((block as ToolUseBlock).name === 'Agent' ||
      (block as ToolUseBlock).name === 'spawn_agent')
  )
}

// The main renderer for a single assistant or user conversation
// entry. Branches on content shape:
//   - string content (user prompts only — tool_results are always
//     block-form) → single MarkerRow, UserBand wrapper for role='user'.
//   - array content → one Block per element; the UserBand wrapper
//     lives INSIDE Block at the text-block level, not around the
//     whole row (see the CRITICAL comment below for the tool_result
//     + role='user' gotcha).
export const ConversationRow = memo(function ConversationRow({
  entry,
}: {
  entry: ConversationEntry
}) {
  const role = entry.message.role
  const content = entry.message.content

  // Simple string content — render as a single marker + text line.
  // For role==='user' this IS a real user prompt (no tool_result can
  // appear here because tool_results are always block-form), so this
  // is the one place a top-level UserBand is correct.
  if (typeof content === 'string') {
    if (role === 'user') {
      return (
        <UserBand>
          <MarkerRow marker="❯">
            <TextProse text={content} />
          </MarkerRow>
        </UserBand>
      )
    }
    return (
      <MarkerRow marker="⏺">
        <TextProse text={content} />
      </MarkerRow>
    )
  }

  if (!Array.isArray(content)) return null

  // Multi-block content — render each block with its own layout.
  //
  // CRITICAL: we do NOT wrap this whole row in a UserBand even when
  // role === 'user'. That's because tool_result blocks ride inside
  // user-role messages (Anthropic API shape: the user turn that follows
  // an assistant tool_use holds the tool_result), and painting the
  // user-prompt highlight behind tool output looks identical to saying
  // "this file read was a user prompt." Confusing and wrong.
  //
  // The band lives at the *block* level instead: Block() wraps text
  // blocks in a UserBand when role === 'user', and leaves every other
  // block type (tool_use, tool_result, thinking) visually untouched.
  return <div className="flex flex-col gap-2">{renderBlocks(content, role)}</div>
})

// Walk the block list, coalescing a run of ≥2 adjacent `Agent` spawns (same
// assistant turn) under one SubagentGroupHeader so the user sees a single
// "Spawned N agents" tally instead of N anonymous cards. A lone `Agent` block
// renders as a plain TaskSubagentRow (no header — there's nothing to count).
// Every other block renders exactly as before, so this is invisible to
// non-Agent content. Grouping is gated to assistant turns: an `Agent` tool_use
// only ever appears in an assistant message, but being explicit keeps the
// user-band rules in Block untouched.
function renderBlocks(
  content: ContentBlock[],
  role: 'user' | 'assistant',
): ReactNode[] {
  if (role !== 'assistant') {
    return content.map((block, i) => <Block key={i} block={block} role={role} />)
  }
  const out: ReactNode[] = []
  for (let i = 0; i < content.length; ) {
    if (isAgentBlock(content[i])) {
      let j = i
      const ids: string[] = []
      while (j < content.length && isAgentBlock(content[j])) {
        ids.push((content[j] as ToolUseBlock).id)
        j++
      }
      if (ids.length > 1) {
        out.push(<SubagentGroupHeader key={`agents-${i}`} toolUseIds={ids} />)
      }
      for (let k = i; k < j; k++) {
        out.push(<Block key={k} block={content[k]} role={role} />)
      }
      i = j
    } else {
      out.push(<Block key={i} block={content[i]} role={role} />)
      i++
    }
  }
  return out
}
