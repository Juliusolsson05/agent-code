// Claude-specific tool row renderers extracted from Feed.tsx.
//
// Each component renders a specific Claude Code tool_use block with
// rich formatting: Edit/MultiEdit show line-level diffs, Write shows
// a green-tinted code slab, TodoWrite shows a checklist. They all
// compose MarkerRow from the shared Feed framework and import
// provider-agnostic helpers (diffLines, DiffLine) from core/parsers.
//
// Lives under feed/claude/ so codex can have its own sibling set
// (feed/codex/CodexRows.tsx) without mixing provider logic.

import { memo, useContext, useMemo } from 'react'

import { formatToolFilePath } from '@shared/paths/displayPath'
import type { ToolUseBlock } from '@shared/types/transcript'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { CodeRenderContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

/* ---------- Shared helpers ---------- */

/** Header row for file-tool blocks: "⏺ Edit  <path>"
 *
 * WHY we show a workspace-relative path instead of the basename:
 * agents hand us absolute paths, and a repo can easily have a dozen
 * files called `index.tsx`; the basename alone is ambiguous. We pull
 * `workspaceRoot` from CodeRenderContext (= the session cwd) and
 * render the path relative to it. Paths outside the workspace stay
 * absolute so the user notices edits to tempfiles, dotfiles, or
 * files in another project. See shared/paths/displayPath.ts for the
 * formatting rule.
 *
 * The `title` attribute still carries the raw filePath so hover
 * always reveals the unambiguous absolute location regardless of
 * which form we render.
 */
function FileToolHeader({
  name,
  filePath,
  extra,
}: {
  name: string
  filePath: string
  extra?: string
}) {
  const { workspaceRoot } = useContext(CodeRenderContext)
  const display = formatToolFilePath(filePath, workspaceRoot)
  return (
    <div className="text-[13px] leading-[1.65] flex items-baseline min-w-0" title={filePath || undefined}>
      <span className="text-accent font-semibold flex-shrink-0">{name}</span>
      {display && (
        // Left-side truncation so the filename stays visible when the
        // pane is narrow. `text-overflow: ellipsis` only drops from the
        // end of the text in the *writing direction*, so we flip the
        // container to RTL and re-align to the left: overflow now
        // collapses the leading `src/renderer/src/...` portion while
        // the trailing `Feed.tsx` — the part the user actually wants
        // to see — always remains on-screen.
        //
        // Caveat: RTL direction can reorder neutral characters (e.g.
        // `/`, `.`) at the very start or end of the string. File
        // paths are strong-LTR runs of ASCII letters with neutrals
        // only between them, so in practice they render correctly
        // without extra bidi isolates.
        <span
          className="text-ink-dim ml-2 font-code text-[12px] truncate min-w-0"
          style={{ direction: 'rtl', textAlign: 'left' }}
        >
          {display}
        </span>
      )}
      {extra && <span className="text-muted ml-2 text-[11px] flex-shrink-0">{extra}</span>}
    </div>
  )
}

/* ---------- TodoWrite ---------- */

type TodoItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

function parseTodos(block: ToolUseBlock): TodoItem[] {
  const input = (block.input ?? {}) as Record<string, unknown>
  const raw = Array.isArray(input.todos) ? input.todos : []
  return raw.map(t => {
    const item = (t ?? {}) as Record<string, unknown>
    const status =
      item.status === 'in_progress' || item.status === 'completed'
        ? item.status
        : 'pending'
    return {
      content: typeof item.content === 'string' ? item.content : '',
      status,
      activeForm: typeof item.activeForm === 'string' ? item.activeForm : '',
    }
  })
}

// `label` exists for cross-provider reuse (2026-07-06): OpenCode's
// `todowrite` tool emits the same `{todos:[{content,status,…}]}` input shape
// this row already parses defensively, so its dispatch reuses TodoRow rather
// than cloning it — but the header must name the tool the AGENT actually
// called, not hardcode Claude's "TodoWrite".
export const TodoRow = memo(function TodoRow({ block, label = 'TodoWrite' }: { block: ToolUseBlock; label?: string }) {
  const todos = useMemo(() => parseTodos(block), [block])
  const done = todos.filter(t => t.status === 'completed').length
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">{label}</span>
          <span className="text-muted text-[11px] tabular-nums">
            {done} / {todos.length} done
          </span>
        </div>
        {todos.length === 0 ? (
          <div className="text-muted text-[12px] italic">(empty list)</div>
        ) : (
          <ul className="flex flex-col gap-0.5 list-none m-0 p-0">
            {todos.map((t, i) => (
              <TodoItemRow key={i} item={t} />
            ))}
          </ul>
        )}
      </div>
    </MarkerRow>
  )
})

const TodoItemRow = memo(function TodoItemRow({ item }: { item: TodoItem }) {
  const glyph =
    item.status === 'completed'
      ? '☑'
      : item.status === 'in_progress'
        ? '◐'
        : '☐'
  const textCls =
    item.status === 'completed'
      ? 'text-muted line-through'
      : item.status === 'in_progress'
        ? 'text-ink'
        : 'text-ink-dim'
  const glyphCls =
    item.status === 'completed'
      ? 'text-accent'
      : item.status === 'in_progress'
        ? 'text-accent'
        : 'text-muted'
  const label =
    item.status === 'in_progress' && item.activeForm
      ? item.activeForm
      : item.content
  return (
    <li className="flex items-start gap-2 text-[13px] leading-[1.55]">
      <span
        className={`${glyphCls} select-none flex-shrink-0 w-4 tabular-nums`}
        aria-hidden="true"
      >
        {glyph}
      </span>
      <span className={`${textCls} flex-1 min-w-0 break-words`}>
        {label}
      </span>
    </li>
  )
})
