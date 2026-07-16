// Claude `MultiEdit` component (dir-per-component convention — see
// components/edit/index.tsx).
//
// STILL LEGACY-RENDERED: MultiEdit deliberately did NOT cut over to the
// code-edit protocol with Edit/Write (Phase 5), because its paging strategy
// (bounded per-page normalization + LCS diffs over an untrusted, possibly
// thousands-long edits array) has no protocol counterpart yet. The migration
// plan is to grow paging INTO CodeEditRenderModel (a `pages` notion on the
// files array) rather than flattening pages away here — flattening would
// regress the exact DoS protection this component exists to provide.

import { memo, useContext, useMemo, useState } from 'react'

import { canDiffLinesInline, diffLines } from '@shared/parsers/lineDiff'
import { formatToolFilePath } from '@shared/paths/displayPath'
import type { ToolUseBlock } from '@shared/types/transcript'
import { CodeRenderContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { DiffSlab } from '@providers/shared/renderer/rows/DiffSlab'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'

/** Header row for file-tool blocks: "⏺ MultiEdit  <path>"
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

const MULTI_EDIT_PAGE_SIZE = 20

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
  const [pageStart, setPageStart] = useState(0)
  const safePageStart = Math.min(
    pageStart,
    Math.max(0, Math.floor((edits.length - 1) / MULTI_EDIT_PAGE_SIZE) * MULTI_EDIT_PAGE_SIZE),
  )
  // WHY both normalization and rendering operate on one page: an untrusted MultiEdit can contain
  // thousands of entries, each with an LCS diff and code DOM. Memoizing each child does not reduce
  // the first mount. Paging preserves exact access to every edit while bounding allocations and
  // React ownership independently of payload cardinality.
  const normalized = edits.slice(safePageStart, safePageStart + MULTI_EDIT_PAGE_SIZE).map(e => ({
    oldString: typeof e.old_string === 'string' ? e.old_string : '',
    newString: typeof e.new_string === 'string' ? e.new_string : '',
  }))
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <FileToolHeader
          name="MultiEdit"
          filePath={filePath}
          extra={`${edits.length} change${edits.length === 1 ? '' : 's'}`}
        />
        <div className="flex flex-col gap-2">
          {normalized.map((e, i) => (
            <MultiEditChunk
              key={safePageStart + i}
              index={safePageStart + i}
              total={edits.length}
              filePath={filePath}
              edit={e}
            />
          ))}
          {edits.length > MULTI_EDIT_PAGE_SIZE ? (
            <div className="flex items-center gap-3 text-[11px] text-muted">
              <span>
                changes {safePageStart + 1}–{Math.min(edits.length, safePageStart + normalized.length)}
                {' '}of {edits.length}
              </span>
              {safePageStart > 0 ? (
                <button
                  type="button"
                  className="cursor-pointer hover:text-ink"
                  onClick={() => setPageStart(Math.max(0, safePageStart - MULTI_EDIT_PAGE_SIZE))}
                >
                  previous
                </button>
              ) : null}
              {safePageStart + MULTI_EDIT_PAGE_SIZE < edits.length ? (
                <button
                  type="button"
                  className="cursor-pointer hover:text-ink"
                  onClick={() => setPageStart(safePageStart + MULTI_EDIT_PAGE_SIZE)}
                >
                  next
                </button>
              ) : null}
            </div>
          ) : null}
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
    () => canDiffLinesInline(edit.oldString, edit.newString)
      ? diffLines(edit.oldString, edit.newString)
      : null,
    [edit.oldString, edit.newString],
  )
  return (
    <div>
      {total > 1 && (
        <div className="text-muted text-[10px] uppercase tracking-wider mb-0.5 select-none">
          change {index + 1} / {total}
        </div>
      )}
      {lines ? (
        <DiffSlab lines={lines} filePath={filePath} emptyLabel="(no changes)" />
      ) : (
        <OversizedEditSlab oldString={edit.oldString} newString={edit.newString} />
      )}
    </div>
  )
})

const OversizedEditSlab = memo(function OversizedEditSlab({
  oldString,
  newString,
}: {
  oldString: string
  newString: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="rounded border border-border bg-surface px-2.5 py-2 text-[12px]"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none text-ink-dim">
        Large edit · view paged before/after content
      </summary>
      {open ? (
        <div className="mt-2 grid gap-3">
          <section>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">Before</div>
            <PagedTextViewer source={oldString} />
          </section>
          <section>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-muted">After</div>
            <PagedTextViewer source={newString} />
          </section>
        </div>
      ) : null}
    </details>
  )
})
