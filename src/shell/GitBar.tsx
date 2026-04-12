import { useCallback, useEffect, useRef, useState } from 'react'

// GitBar — a narrow right-edge panel showing git state for the
// focused pane's cwd: current branch, latest 5 commits, and the
// full diff summary (files changed with green +N / red -N counts).
//
// Toggled via the "Show Git Bar" / "Hide Git Bar" command in the
// command palette. Fetches fresh data on open and re-polls every
// 10 seconds while visible so it stays current as CC makes changes.

type GitFile = { file: string; additions: number; deletions: number }
type GitCommit = {
  hash: string
  subject: string
  author: string
  relativeDate: string
}
type GitData = {
  branch: string
  files: GitFile[]
  commits: GitCommit[]
}

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

          {data.files.length === 0 && (
            <div className="px-3 py-2 border-b border-border text-muted">
              working tree clean
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

function shortenPath(p: string): string {
  const parts = p.split('/')
  if (parts.length <= 2) return p
  return '…/' + parts.slice(-2).join('/')
}
