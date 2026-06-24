import { useCallback, useEffect, useRef, useState } from 'react'
// Shared GitBar contract — the SAME type the main handler returns and the
// preload bridge re-exports. Deriving the renderer's view shapes from it means
// a field change in `git:status` is a compile error in this component instead
// of a silent mismatch. See @shared/types/gitStatus for the invariants.
import type {
  GitBarStatusResult,
  GitNumstatLine,
  GitRecentCommit,
  GitSubmoduleStatus,
} from '@shared/types/gitStatus'

// GitBar — a narrow right-edge panel showing git state for the
// focused pane's cwd: current branch, latest 5 commits, and the
// full diff summary (files changed with green +N / red -N counts).
//
// Toggled via the "Show Git Bar" / "Hide Git Bar" command in the
// command palette. Fetches fresh data on open and re-polls every
// 10 seconds while visible so it stays current as CC makes changes.
//
// Conditional rendering in App.tsx (`{gitBarOpen && <GitBar />}`) means
// this component fully unmounts when the bar is hidden — the useEffect
// cleanup clears the poll interval, so no git subprocesses run while
// the bar is closed. That matters because we now spawn extra commands
// per submodule; ensuring the work only happens on-screen keeps the
// idle cost at zero.

// Local aliases over the shared contract so the JSX below stays terse. These
// are NOT redeclarations — they point at the canonical shapes so they can never
// drift from what main actually sends.
//   - GitFile: numstat row (binary '-' coerced to 0/0 by the shared parser).
//   - GitSubmodule: a submodule row carries its own inner file list because the
//     parent `git diff --numstat` only surfaces the gitlink (+1/-1), useless
//     signal; main walks into each submodule for the real per-file numbers.
type GitFile = GitNumstatLine
type GitCommit = GitRecentCommit
type GitSubmodule = GitSubmoduleStatus
// The success branch of the discriminated union — the renderer only ever stores
// data once it has narrowed on `result.ok`, so `GitData` is exactly the ok:true
// variant. Extract keeps it tied to the union instead of restating its fields.
type GitData = Extract<GitBarStatusResult, { ok: true }>

type Props = {
  cwd: string | null
  onClose: () => void
}

export function GitBar({ cwd, onClose }: Props) {
  const [data, setData] = useState<GitData | null>(null)
  const [error, setError] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    if (!cwd) return
    const result = await window.api.gitStatus(cwd)
    if (result.ok) {
      setData(result)
      setError(false)
    } else {
      setData(null)
      setError(true)
    }
  }, [cwd])

  // Fetch on mount + poll every 10s.
  useEffect(() => {
    void refresh()
    timerRef.current = setInterval(() => void refresh(), 10_000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [refresh])

  const totalAdd = data?.files.reduce((s, f) => s + f.additions, 0) ?? 0
  const totalDel = data?.files.reduce((s, f) => s + f.deletions, 0) ?? 0

  return (
    <div className="
      h-full w-[280px] flex-shrink-0
      border-l border-border bg-surface
      flex flex-col
      overflow-hidden
      text-[11px] font-code
    ">
      {/* Header */}
      <div className="
        flex items-center justify-between
        px-3 py-2
        border-b border-border
        text-[10px] text-muted uppercase tracking-wider
        select-none flex-shrink-0
      ">
        <span>git</span>
        <button
          type="button"
          onClick={onClose}
          className="text-muted hover:text-ink text-[14px] leading-none"
        >
          ×
        </button>
      </div>

      {error && (
        <div className="px-3 py-4 text-muted text-center">
          not a git repository
        </div>
      )}

      {data && (
        <div className="flex-1 overflow-y-auto">
          {/* Branch */}
          <div className="px-3 py-2 border-b border-border">
            <span className="text-muted">branch </span>
            <span className="text-accent">{data.branch}</span>
          </div>

          {/* Diff summary */}
          {data.files.length > 0 && (
            <div className="border-b border-border">
              <div className="px-3 py-1.5 text-[10px] text-muted uppercase tracking-wider select-none">
                changes
                <span className="ml-2 normal-case tracking-normal">
                  <span className="text-green-400">+{totalAdd}</span>
                  {' '}
                  <span className="text-red-400">-{totalDel}</span>
                </span>
              </div>
              <div className="flex flex-col">
                {data.files.map(f => (
                  <div
                    key={f.file}
                    className="
                      flex items-center gap-2
                      px-3 py-0.5
                      hover:bg-surface-hi
                    "
                  >
                    <span className="flex-1 min-w-0 truncate text-ink-dim" title={f.file}>
                      {shortenPath(f.file)}
                    </span>
                    <span className="flex-shrink-0 tabular-nums">
                      {f.additions > 0 && (
                        <span className="text-green-400">+{f.additions}</span>
                      )}
                      {f.additions > 0 && f.deletions > 0 && ' '}
                      {f.deletions > 0 && (
                        <span className="text-red-400">-{f.deletions}</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.files.length === 0 && !data.submodules?.length && (
            <div className="px-3 py-2 border-b border-border text-muted">
              working tree clean
            </div>
          )}

          {/* Submodules — each row is independently collapsible so a
              submodule with a large diff doesn't dominate the bar. */}
          {data.submodules && data.submodules.length > 0 && (
            <div className="border-b border-border">
              <div className="px-3 py-1.5 text-[10px] text-muted uppercase tracking-wider select-none">
                submodules
              </div>
              <div className="flex flex-col">
                {data.submodules.map(s => (
                  <SubmoduleRow key={s.path} sub={s} />
                ))}
              </div>
            </div>
          )}

          {/* Recent commits */}
          {data.commits.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-[10px] text-muted uppercase tracking-wider select-none">
                recent commits
              </div>
              <div className="flex flex-col">
                {data.commits.map(c => (
                  <div
                    key={c.hash}
                    className="px-3 py-1 hover:bg-surface-hi"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-accent flex-shrink-0">{c.hash}</span>
                      <span className="text-muted flex-shrink-0">{c.relativeDate}</span>
                    </div>
                    <div className="text-ink-dim truncate" title={c.subject}>
                      {c.subject}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {!data && !error && (
        <div className="px-3 py-4 text-muted text-center">loading…</div>
      )}
    </div>
  )
}

function SubmoduleRow({ sub }: { sub: GitSubmodule }) {
  // Start collapsed — the header already communicates the summary
  // (state chip + +N/-M) and the point of the bar is a compact
  // overview, not an embedded diff viewer. User clicks to expand.
  const [open, setOpen] = useState(false)
  const totalAdd = sub.files.reduce((s, f) => s + f.additions, 0)
  const totalDel = sub.files.reduce((s, f) => s + f.deletions, 0)

  // State chip text. "new commits" matches git's own prose for bumped
  // gitlinks; "dirty" covers uncommitted worktree edits. A submodule
  // that's both gets the concatenated chip so both signals are visible
  // at a glance.
  const chipText = sub.state === 'both'
    ? 'new commits · dirty'
    : sub.state === 'bumped'
      ? 'new commits'
      : 'dirty'

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-1 text-left hover:bg-surface-hi"
      >
        <span className="text-muted w-2 text-[9px] tabular-nums select-none">
          {open ? '▾' : '▸'}
        </span>
        <span
          className="flex-1 min-w-0 truncate text-ink-dim"
          title={sub.path}
        >
          {sub.path}
        </span>
        <span className="text-[9px] text-muted uppercase tracking-wider whitespace-nowrap">
          {chipText}
        </span>
        <span className="flex-shrink-0 tabular-nums">
          {totalAdd > 0 && <span className="text-green-400">+{totalAdd}</span>}
          {totalAdd > 0 && totalDel > 0 && ' '}
          {totalDel > 0 && <span className="text-red-400">-{totalDel}</span>}
        </span>
      </button>

      {open && sub.range && (
        <div className="px-3 pb-0.5 text-[9px] text-muted tabular-nums select-none">
          {sub.range.from} → {sub.range.to}
        </div>
      )}

      {open && sub.files.length > 0 && (
        <div className="flex flex-col pb-1">
          {sub.files.map(f => (
            <div
              key={f.file}
              className="flex items-center gap-2 px-6 py-0.5 hover:bg-surface-hi"
            >
              <span className="flex-1 min-w-0 truncate text-ink-dim" title={f.file}>
                {shortenPath(f.file)}
              </span>
              <span className="flex-shrink-0 tabular-nums">
                {f.additions > 0 && <span className="text-green-400">+{f.additions}</span>}
                {f.additions > 0 && f.deletions > 0 && ' '}
                {f.deletions > 0 && <span className="text-red-400">-{f.deletions}</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {open && sub.files.length === 0 && (
        <div className="px-6 pb-1 text-muted italic">(no file-level changes)</div>
      )}
    </div>
  )
}

function shortenPath(p: string): string {
  const parts = p.split('/')
  if (parts.length <= 2) return p
  return '…/' + parts.slice(-2).join('/')
}
