import { createContext } from 'react'

import type {
  ToolResultBlock,
  ToolUseBlock,
} from '@shared/types/transcript'

import type { AgentProvider } from '@renderer/features/feed/types'
import type { SubAgentState } from '@renderer/workspace/workspaceState'
import type { ClaudeAskUserQuestionState } from '@shared/types/providerConditions'

// ---------------------------------------------------------------------------
// Feed contexts.
//
// Four contexts propagate state down from the Feed container to the
// per-row renderers without prop-drilling through every level of the
// tree:
//
//   ProviderContext         — which provider's row renderers to use.
//   ToolUseIndexContext     — tool_use_id → ToolUseBlock. Used by
//                             ToolResultRow to look up the originating
//                             tool for richer rendering (Read →
//                             syntax-highlighted code; Bash → plain
//                             pre; …).
//   ToolResultIndexContext  — reverse of the above. Used by the
//                             tool_use dispatcher when a single
//                             combined widget wants to render command
//                             + output on one row (git widgets).
//   CodeRenderContext       — sessionId + workspaceRoot, passed to
//                             fenced code blocks inside prose so the
//                             CodeBlock can mint stable codeIds and
//                             wire LSP against the right root.
//
// Why side-channel maps instead of passing props structurally:
//   tool_use blocks live in an ASSISTANT entry and tool_result blocks
//   live in the NEXT USER entry. ConversationRow only sees one entry
//   at a time, so it can't pair them without reaching across entries.
//   The Feed level (which DOES have every entry) builds the maps and
//   hands them down through context.
//
// Memo behavior: the map references change whenever `entries` change,
// which invalidates useContext consumers. That's fine — rows that
// care about the maps already re-render when entries grow, and rows
// that don't call useContext are unaffected. We do NOT include the
// maps in row memo keys; equality on the maps themselves would be
// expensive and the interesting work (markdown parsing) is cached
// inside TextProse by text string, so repeat renders are cheap.

export const ProviderContext = createContext<AgentProvider>('claude')

export const ToolUseIndexContext = createContext<Map<string, ToolUseBlock>>(new Map())

// Reverse of ToolUseIndexContext — lets the tool_use dispatcher peek
// at the paired result block, so a single combined widget can render
// both sides (command + output) on one row. Needed for the git
// widgets: the result content lives on a later entry but the widget
// wants it available when the tool_use row mounts. When the result
// hasn't arrived yet the map returns undefined and the widget renders
// a "running…" placeholder; on the next entry wave it re-renders
// with the real output.
export const ToolResultIndexContext =
  createContext<Map<string, ToolResultBlock>>(new Map())

export const CodeRenderContext = createContext<{
  sessionId: string
  workspaceRoot: string | null
}>({
  sessionId: '',
  workspaceRoot: null,
})

// Live AskUserQuestion picker state for THIS session, or null when no
// picker is on screen. Provided by Feed (which has the runtime) and read by
// AskUserQuestionRow, which only sees its own block and needs the
// session-wide "is the picker live right now?" signal that lives on the
// runtime one level up — the same side-channel pattern as SubAgentsContext
// below and the ToolResult/ToolUse index contexts above.
//
// WHY this is the gate for the stale-render fix: an unanswered
// AskUserQuestion tool_use block stays unresolved (`!resultAt`) in the
// transcript forever if the user interrupts or moves on. The block alone
// can't tell whether the picker is still on screen, so without this signal
// the row would ghost-render many messages later. A NON-NULL value here
// means CC is drawing the picker right now; a null means it's gone and the
// row must not render. Only one AskUserQuestion picker is ever on screen at
// a time, so this single live state corresponds to the current unresolved
// AskUserQuestion block.
export const AskUserQuestionLiveContext =
  createContext<ClaudeAskUserQuestionState | null>(null)

// Subagent fleet state for this session, keyed by parent `Agent` tool_use id.
// The `Agent` tool_use row (and the "Spawned N agents" group header) read this
// to render live status + the drill-in tool-call timeline. Same side-channel
// rationale as the maps above: the row only sees its own block, but needs the
// session-wide subagent map that lives one level up on the runtime. Empty `{}`
// when no subagents exist, so consumers render the plain spawn card.
export const SubAgentsContext = createContext<Record<string, SubAgentState>>({})
