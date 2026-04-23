import { memo } from 'react'

import type { ConversationEntry } from '@shared/types/transcript'

import { MarkerRow } from '../MarkerRow'
import { TextProse } from '../markdown'

import { Block } from './Block'
import { UserBand } from './primitives'

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
  return (
    <div className="flex flex-col gap-2">
      {content.map((block, i) => (
        <Block key={i} block={block} role={role} />
      ))}
    </div>
  )
})
