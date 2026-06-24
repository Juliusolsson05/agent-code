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

import { diffLines } from '@shared/parsers/lineDiff'
import { formatToolFilePath } from '@shared/paths/displayPath'
import type { ToolUseBlock } from '@shared/types/transcript'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { CodeRenderContext } from '@renderer/features/feed/ui/Feed'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { DiffSlab } from '@providers/shared/renderer/rows/DiffSlab'

/* ---------- Shared helpers ---------- */

/** Pull a file path and old/new strings out of a shape we don't fully
 *  trust — the transcript typing is `unknown`. Missing fields become
 *  empty strings so the diff still renders (as "everything added"
 *  or "everything removed") without crashing. */
function editInput(
  block: ToolUseBlock,
): { filePath: string; oldString: string; newString: string } {
  const input = (block.input ?? {}) as Record<string, unknown>
  return {
    filePath: typeof input.file_path === 'string' ? input.file_path : '',
    oldString: typeof input.old_string === 'string' ? input.old_string : '',
    newString: typeof input.new_string === 'string' ? input.new_string : '',
  }
}

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

/* ---------- Edit ---------- */

export const EditRow = memo(function EditRow({ block }: { block: ToolUseBlock }) {
  const { filePath, oldString, newString } = editInput(block)
  const lines = useMemo(
    () => diffLines(oldString, newString),
    [oldString, newString],
  )
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <FileToolHeader name="Edit" filePath={filePath} />
        <DiffSlab lines={lines} filePath={filePath} emptyLabel="(no changes)" />
      </div>
    </MarkerRow>
  )
})

/* ---------- MultiEdit ---------- */

export const MultiEditRow = memo(function MultiEditRow({
  block,
}: {
  block: ToolUseBlock
}) {
  const input = (block.input ?? {}) as Record<string, unknown>
  const filePath =
    typeof input.file_path === 'string' ? input.file_path : ''
  const edits = Array.isArray(input.edits)
    ? (input.edits as Array<Record<string, unknown>>)
    : []
  const normalized = edits.map(e => ({
    oldString: typeof e.old_string === 'string' ? e.old_string : '',
    newString: typeof e.new_string === 'string' ? e.new_string : '',
  }))
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <FileToolHeader
          name="MultiEdit"
          filePath={filePath}
          extra={`${normalized.length} change${normalized.length === 1 ? '' : 's'}`}
        />
        <div className="flex flex-col gap-2">
          {normalized.map((e, i) => (
            <MultiEditChunk
              key={i}
              index={i}
              total={normalized.length}
              filePath={filePath}
              edit={e}
            />
          ))}
        </div>
      </div>
    </MarkerRow>
  )
})

const MultiEditChunk = memo(function MultiEditChunk({
  index,
  total,
  filePath,
  edit,
}: {
  index: number
  total: number
  filePath: string
  edit: { oldString: string; newString: string }
}) {
  const lines = useMemo(
    () => diffLines(edit.oldString, edit.newString),
    [edit.oldString, edit.newString],
  )
  return (
    <div>
      {total > 1 && (
        <div className="text-muted text-[10px] uppercase tracking-wider mb-0.5 select-none">
          change {index + 1} / {total}
        </div>
      )}
      <DiffSlab lines={lines} filePath={filePath} emptyLabel="(no changes)" />
    </div>
  )
})

/* ---------- Write ---------- */

export const WriteRow = memo(function WriteRow({ block }: { block: ToolUseBlock }) {
  const input = (block.input ?? {}) as Record<string, unknown>
  const filePath = typeof input.file_path === 'string' ? input.file_path : ''
  const content = typeof input.content === 'string' ? input.content : ''
  const codeContext = useContext(CodeRenderContext)
  const lineCount = useMemo(() => {
    if (!content) return 0
    const normalized = content.endsWith('\n') ? content.slice(0, -1) : content
    return normalized === '' ? 0 : normalized.split('\n').length
  }, [content])
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <FileToolHeader
          name="Write"
          filePath={filePath}
          extra={`${lineCount} line${lineCount === 1 ? '' : 's'}`}
        />
        <CodeBlock
          code={content}
          path={filePath}
          workspaceRoot={codeContext.workspaceRoot}
          codeId={`write:${block.id}`}
        />
      </div>
    </MarkerRow>
  )
})

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

export const TodoRow = memo(function TodoRow({ block }: { block: ToolUseBlock }) {
  const todos = useMemo(() => parseTodos(block), [block])
  const done = todos.filter(t => t.status === 'completed').length
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">TodoWrite</span>
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
