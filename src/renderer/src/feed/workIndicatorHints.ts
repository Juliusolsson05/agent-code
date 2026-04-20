// workIndicatorHints — pure helpers that convert the current semantic
// turn + pending-tool id into a ≤1-line hint for the WorkIndicator.
//
// WHY this lives outside WorkIndicator.tsx: keeps the rendering component
// free of semantic-turn knowledge. `Feed.tsx` already has the turn in
// hand (it's already threading it through for SemanticStreamingTurn),
// so computing the hint there and passing it as a prop means
// WorkIndicator is a dumb string renderer — which makes phase-by-phase
// visual tests trivial and keeps the component memo-friendly (it only
// re-renders when the hint string changes, not on every block delta).

import type { SemanticLiveBlock, SemanticLiveTurn } from '../tiles/workspaceState'

/** Pull a short, single-line hint for the pending tool call. When the
 *  tool's parsed input is available (finalised JSON from
 *  tool_input_finalized), extract a user-visible summary — the file
 *  path for file ops, the first line of the command for bash, the
 *  query for search tools, etc. Returns `null` when no useful hint
 *  can be derived; WorkIndicator then shows just "Calling Read" with
 *  no suffix, which is still readable. */
export function toolHintFromTurn(
  turn: SemanticLiveTurn | null,
  pendingToolUseId: string | null,
): string | null {
  if (!turn || !pendingToolUseId) return null
  const block = findToolBlock(turn, pendingToolUseId)
  if (!block) return null
  return toolHintFromBlock(block)
}

/** Search the semantic turn's blocks for a tool-use/function-call block
 *  matching the given id. Scans in reverse order because the pending
 *  tool is almost always the last block in the turn — saves a linear
 *  scan on long turns. */
function findToolBlock(
  turn: SemanticLiveTurn,
  toolUseId: string,
): SemanticLiveBlock | null {
  const keys = Object.keys(turn.blocks)
  for (let i = keys.length - 1; i >= 0; i--) {
    const block = turn.blocks[Number(keys[i])]
    if (!block) continue
    if (block.toolUseId === toolUseId || block.callId === toolUseId) {
      return block
    }
  }
  return null
}

/** Inspect the block's parsed input (populated by
 *  tool_input_finalized) and return a user-friendly suffix. Fallback
 *  order:
 *    1. Claude's file-ops: file_path / path / pattern / query.
 *    2. Claude Bash: first line of `command`.
 *    3. Codex function_call: similar fields from parsedInput.
 *    4. Any string-valued `description` / `notebook_path` / `url`.
 *    5. null.
 *
 *  This is intentionally narrow — we don't try to "render" tool args,
 *  just surface the one field most tools would stick a filename or
 *  command into. The user sees the full input when they scroll down
 *  to the actual tool row; this is chrome above the fold. */
export function toolHintFromBlock(block: SemanticLiveBlock): string | null {
  const parsed = block.parsedInput
  if (parsed && typeof parsed === 'object') {
    const pick = (key: string): string | null => {
      const v = (parsed as Record<string, unknown>)[key]
      return typeof v === 'string' && v.length > 0 ? v : null
    }
    // Preference order matches what a user would most likely want to
    // see as a one-line hint: the path/query the tool is operating on.
    const first =
      pick('file_path') ??
      pick('path') ??
      pick('notebook_path') ??
      pick('pattern') ??
      pick('query') ??
      pick('url')
    if (first) return truncate(first)
    // Bash command — use the first non-empty line so multi-line
    // heredocs don't blow out the row.
    const command = pick('command')
    if (command) {
      const firstLine = command.split('\n', 1)[0]?.trim()
      if (firstLine) return truncate(firstLine)
    }
    // Last-ditch free-form description.
    const description = pick('description')
    if (description) return truncate(description)
  }
  // Codex stores raw argumentsJson on the block. As a fallback, show
  // the first line of that string (rare — parsedInput usually wins).
  if (typeof block.argumentsJson === 'string' && block.argumentsJson.length > 0) {
    const firstLine = block.argumentsJson.split('\n', 1)[0]?.trim()
    if (firstLine) return truncate(firstLine)
  }
  return null
}

const MAX_HINT_LEN = 80

function truncate(s: string): string {
  if (s.length <= MAX_HINT_LEN) return s
  return s.slice(0, MAX_HINT_LEN - 1) + '…'
}
