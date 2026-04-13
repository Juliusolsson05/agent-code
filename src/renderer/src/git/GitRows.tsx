// Custom renderers for git invocations in the feed.
//
// These replace the generic Bash/exec_command tool_use + tool_result
// rows with purpose-built widgets when the "Toggle Custom Rendering"
// palette command is on. Gated by CustomRenderingContext; when off,
// the feed falls back to its usual generic rendering.
//
// Design choices:
//
//   - We render the widget on the RESULT row (by reading the command
//     back out of ToolUseIndexContext). The feed's main dispatcher
//     suppresses the paired tool_use row so we don't show a "command
//     card" above a "widget card" — the widget already carries the
//     command in its header. This mirrors how Claude's Edit tool
//     collapses: tool_use renders the diff, tool_result suppresses.
//
//   - Each widget parses the raw stdout with the pure parsers in
//     shared/git/gitParse.ts. Parsing never throws — on an
//     unexpected format the result is a partial/empty shape and we
//     fall back to showing the raw stdout. Principle: custom
//     rendering must never lose information the user could have
//     seen from the generic renderer.
//
//   - Reuses the DiffSlab look from ClaudeRows (red/green per-line
//     tinting, monospace). I didn't import DiffSlab directly because
//     GitDiffHunks have a slightly richer shape (per-hunk headers,
//     per-file grouping) and re-implementing the slab inline keeps
//     the dependency direction one-way (renderer → shared git).

import { memo, useMemo, useState } from 'react'
import hljs from 'highlight.js'

import { MarkerRow } from '../feed/Feed'
import { normalizeCodeLanguage } from '../../../shared/code/language'
import type { GitIntent } from '../../../shared/git/gitDetect'
import {
  parseGitCommit,
  parseGitLog,
  parseGitPush,
  parseGitStatus,
  parseUnifiedDiff,
  stripAnsi,
  type GitDiffFile,
  type GitDiffLine,
} from '../../../shared/git/gitParse'

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

/**
 * Header strip at the top of every card. Renders subcommand, flag
 * chips, and any summary badges on the right. Deliberately low-
 * chrome: no border around the header itself — the card's own
 * surface provides the outline.
 */
function GitCardHeader({
  sub,
  flags,
  paths,
  badges,
}: {
  sub: string
  flags?: string[]
  paths?: string[]
  badges?: React.ReactNode
}) {
  return (
    <div className="flex items-baseline gap-2 text-[12px] leading-[1.5] mb-1.5">
      <span className="text-accent font-semibold">git {sub}</span>
      {flags?.map(f => (
        <span
          key={f}
          className="font-code text-[11px] text-ink-dim bg-code-bg px-1.5 py-0.5 rounded"
        >
          {f}
        </span>
      ))}
      {paths && paths.length > 0 && paths.length <= 3 && (
        <span className="font-code text-[11px] text-muted truncate min-w-0">
          {paths.join(' ')}
        </span>
      )}
      <div className="flex-1" />
      {badges}
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  // Paper surface on top of the feed's content column. Slightly
  // inset so it doesn't bleed into the marker gutter.
  return (
    <div className="bg-surface border border-border rounded-md px-3 py-2">
      {children}
    </div>
  )
}

function PlusMinus({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="font-code text-[11px] tabular-nums whitespace-nowrap">
      <span className="text-diff-add-fg">+{added}</span>
      <span className="text-ink-dim"> / </span>
      <span className="text-diff-remove-fg">-{removed}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Diff hunk renderer
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function toHighlightLanguage(language: string): string | null {
  if (language === 'javascriptreact') return 'javascript'
  if (language === 'typescriptreact') return 'typescript'
  return hljs.getLanguage(language) ? language : null
}

/**
 * Render a sequence of {hunk, lines} for one file. Hunk header rows
 * are dimmed; +/- lines are colorized per-line with syntax highlighting
 * running INSIDE each line. Per-line highlighting (instead of blob
 * highlighting) is necessary because we need the +/- tint to land on
 * the row background, not on the tokens.
 */
function HunkSlab({
  filePath,
  hunks,
}: {
  filePath: string
  hunks: { header: string; lines: GitDiffLine[] }[]
}) {
  const highlightLanguage = useMemo(
    () => toHighlightLanguage(normalizeCodeLanguage(undefined, filePath)),
    [filePath],
  )
  return (
    <div className="bg-code-bg font-code text-[12px] leading-[1.55] overflow-x-auto">
      {hunks.map((h, hi) => (
        <div key={hi}>
          <div className="px-3 py-0.5 text-[11px] text-muted select-none whitespace-pre">
            {h.header}
          </div>
          {h.lines.map((l, i) => {
            const bg = l.kind === '+'
              ? 'bg-diff-add-bg'
              : l.kind === '-'
                ? 'bg-diff-remove-bg'
                : ''
            const fg = l.kind === '+'
              ? 'text-diff-add-fg'
              : l.kind === '-'
                ? 'text-diff-remove-fg'
                : 'text-code-ink-dim'
            const body = l.kind === 'ctx'
              ? 'text-code-ink-dim'
              : 'text-code-ink'
            // Highlight each line's text body. Empty strings become
            // a zero-width space so the row keeps its height.
            const html = l.text === ''
              ? '\u200b'
              : highlightLanguage
                ? hljs.highlight(l.text, { language: highlightLanguage }).value
                : escapeHtml(l.text)
            return (
              <div
                key={i}
                className={`${bg} flex items-start px-3 whitespace-pre`}
              >
                <span
                  className={`${fg} select-none w-4 flex-shrink-0 tabular-nums`}
                  aria-hidden="true"
                >
                  {l.kind === 'ctx' ? ' ' : l.kind}
                </span>
                <span
                  className={`${body} flex-1 min-w-0 break-all`}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-file collapsible row
// ---------------------------------------------------------------------------

/**
 * Collapse heuristic: if the file has <20 lines of change, open by
 * default. Larger diffs default collapsed so a 400-line change doesn't
 * dominate the feed. The user can expand with a click.
 */
function FileBlock({ file }: { file: GitDiffFile }) {
  const totalChange = file.added + file.removed
  const defaultOpen = totalChange <= 20 && !file.binary
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-left px-1 py-0.5 rounded hover:bg-code-bg"
      >
        <span className="text-ink-dim w-3 text-[10px] tabular-nums select-none">
          {open ? '▾' : '▸'}
        </span>
        <span className="font-code text-[12px] text-ink truncate flex-1 min-w-0">
          {file.oldPath && file.oldPath !== file.path
            ? <>{file.oldPath} <span className="text-ink-dim">→</span> {file.path}</>
            : file.path}
        </span>
        {file.created && <Tag tone="add">new</Tag>}
        {file.deleted && <Tag tone="remove">deleted</Tag>}
        {file.binary && <Tag tone="muted">binary</Tag>}
        <PlusMinus added={file.added} removed={file.removed} />
      </button>
      {open && !file.binary && file.hunks.length > 0 && (
        <HunkSlab filePath={file.path} hunks={file.hunks} />
      )}
    </div>
  )
}

function Tag({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: 'add' | 'remove' | 'muted'
}) {
  const cls = tone === 'add'
    ? 'text-diff-add-fg'
    : tone === 'remove'
      ? 'text-diff-remove-fg'
      : 'text-muted'
  return (
    <span className={`font-code text-[10px] uppercase tracking-wider ${cls}`}>
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// GitDiffCard
// ---------------------------------------------------------------------------

export const GitDiffCard = memo(function GitDiffCard({
  intent,
  output,
}: {
  intent: Extract<GitIntent, { kind: 'diff' }>
  output: string
}) {
  // --name-only and --stat produce non-unified-diff output; render
  // those as the raw stdout (still inside a card) instead of trying
  // to parse them. It's not worth a custom list widget for a rarely-
  // interesting summary; the raw text is already concise.
  if (intent.nameOnly || intent.stat) {
    return (
      <Card>
        <GitCardHeader sub="diff" flags={intent.flags} paths={intent.paths} />
        <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-words m-0">
          {output.trim() || '(no output)'}
        </pre>
      </Card>
    )
  }

  const { files, added, removed } = useMemo(
    () => parseUnifiedDiff(stripAnsi(output)),
    [output],
  )

  // Empty diff (no changes): often `git diff` with clean workspace.
  // Show a small "no changes" muted note instead of a silent card.
  if (files.length === 0) {
    return (
      <Card>
        <GitCardHeader sub="diff" flags={intent.flags} paths={intent.paths} />
        <div className="text-muted text-[12px] italic">(no changes)</div>
      </Card>
    )
  }

  return (
    <Card>
      <GitCardHeader
        sub="diff"
        flags={intent.flags}
        paths={intent.paths}
        badges={
          <span className="flex items-baseline gap-2">
            <span className="text-muted text-[11px]">
              {files.length} file{files.length === 1 ? '' : 's'}
            </span>
            <PlusMinus added={added} removed={removed} />
          </span>
        }
      />
      <div className="flex flex-col gap-1">
        {files.map(f => <FileBlock key={f.path + (f.oldPath ?? '')} file={f} />)}
      </div>
    </Card>
  )
})

// ---------------------------------------------------------------------------
// GitCommitCard
// ---------------------------------------------------------------------------

export const GitCommitCard = memo(function GitCommitCard({
  intent,
  output,
}: {
  intent: Extract<GitIntent, { kind: 'commit' }>
  output: string
}) {
  const result = useMemo(() => parseGitCommit(stripAnsi(output)), [output])

  if (result.noop) {
    return (
      <Card>
        <GitCardHeader
          sub={intent.amend ? 'commit --amend' : 'commit'}
        />
        <div className="text-muted text-[12px] italic">nothing to commit</div>
      </Card>
    )
  }

  return (
    <Card>
      <GitCardHeader
        sub={intent.amend ? 'commit --amend' : 'commit'}
        badges={
          <span className="flex items-baseline gap-2">
            {result.branch && (
              <span className="font-code text-[11px] text-ink-dim bg-code-bg px-1.5 py-0.5 rounded">
                {result.branch}
              </span>
            )}
            {result.sha && (
              <span className="font-code text-[11px] text-accent tabular-nums">
                {result.sha}
              </span>
            )}
          </span>
        }
      />
      {result.subject && (
        <div className="text-ink text-[13px] font-semibold leading-[1.45] mb-0.5">
          {result.subject}
        </div>
      )}
      {result.body && (
        <pre className="font-code text-[11.5px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-words m-0">
          {result.body}
        </pre>
      )}
      {(result.filesChanged !== undefined) && (
        <div className="flex items-baseline gap-3 mt-1.5 text-[11px] text-muted">
          <span>{result.filesChanged} file{result.filesChanged === 1 ? '' : 's'} changed</span>
          <PlusMinus added={result.insertions ?? 0} removed={result.deletions ?? 0} />
        </div>
      )}
    </Card>
  )
})

// ---------------------------------------------------------------------------
// GitStatusCard
// ---------------------------------------------------------------------------

export const GitStatusCard = memo(function GitStatusCard({
  output,
}: {
  intent: Extract<GitIntent, { kind: 'status' }>
  output: string
}) {
  const r = useMemo(() => parseGitStatus(stripAnsi(output)), [output])
  const sections: Array<{ title: string; entries: typeof r.staged }> = [
    { title: 'Staged', entries: r.staged },
    { title: 'Modified', entries: r.modified },
    { title: 'Untracked', entries: r.untracked },
  ]
  const anyEntries = r.staged.length + r.modified.length + r.untracked.length > 0

  return (
    <Card>
      <GitCardHeader
        sub="status"
        badges={r.branch && (
          <span className="font-code text-[11px] text-ink-dim bg-code-bg px-1.5 py-0.5 rounded">
            {r.branch}
          </span>
        )}
      />
      {!anyEntries && (
        <div className="text-muted text-[12px] italic">working tree clean</div>
      )}
      <div className="flex flex-col gap-2">
        {sections.map(s => s.entries.length > 0 && (
          <div key={s.title}>
            <div className="text-muted text-[10px] uppercase tracking-wider mb-0.5">
              {s.title} ({s.entries.length})
            </div>
            <ul className="list-none p-0 m-0 flex flex-col gap-0.5">
              {s.entries.map((e, i) => (
                <li
                  key={i}
                  className="flex items-baseline gap-2 font-code text-[12px]"
                >
                  <StatusCode code={e.code} />
                  <span className="text-ink truncate min-w-0">
                    {e.oldPath ? <>{e.oldPath} <span className="text-ink-dim">→</span> {e.path}</> : e.path}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  )
})

function StatusCode({ code }: { code: string }) {
  const cls = code === 'A'
    ? 'text-diff-add-fg'
    : code === 'D'
      ? 'text-diff-remove-fg'
      : code === 'M'
        ? 'text-accent'
        : code === 'R' || code === 'C'
          ? 'text-accent'
          : 'text-muted'
  return <span className={`${cls} w-3 select-none tabular-nums`}>{code}</span>
}

// ---------------------------------------------------------------------------
// GitAddCard
// ---------------------------------------------------------------------------

/**
 * `git add` typically produces no stdout. The useful info is the
 * INTENT (what was staged). If the user passed specific paths, we
 * list them. If they used `.` / `-A`, we render a one-liner.
 */
export const GitAddCard = memo(function GitAddCard({
  intent,
  output,
}: {
  intent: Extract<GitIntent, { kind: 'add' }>
  output: string
}) {
  const trimmed = stripAnsi(output).trim()
  return (
    <Card>
      <GitCardHeader sub="add" />
      {intent.all
        ? <div className="text-ink-dim text-[12px]">staged all changes</div>
        : intent.paths.length > 0
          ? (
            <ul className="list-none p-0 m-0 flex flex-col gap-0.5">
              {intent.paths.map(p => (
                <li key={p} className="font-code text-[12px] text-ink">{p}</li>
              ))}
            </ul>
          )
          : <div className="text-muted text-[12px] italic">(no paths)</div>
      }
      {trimmed && (
        // If git actually produced output (errors, hints), show it so
        // we don't hide anything from the user.
        <pre className="font-code text-[11.5px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-words m-0 mt-1.5">
          {trimmed}
        </pre>
      )}
    </Card>
  )
})

// ---------------------------------------------------------------------------
// GitLogCard
// ---------------------------------------------------------------------------

export const GitLogCard = memo(function GitLogCard({
  intent,
  output,
}: {
  intent: Extract<GitIntent, { kind: 'log' }>
  output: string
}) {
  const entries = useMemo(() => parseGitLog(stripAnsi(output)), [output])
  return (
    <Card>
      <GitCardHeader
        sub="log"
        flags={intent.oneline ? ['--oneline'] : []}
        badges={intent.limit !== undefined && (
          <span className="text-muted text-[11px]">-{intent.limit}</span>
        )}
      />
      {entries.length === 0 ? (
        <div className="text-muted text-[12px] italic">(no commits)</div>
      ) : (
        <ul className="list-none p-0 m-0 flex flex-col gap-1">
          {entries.map(e => (
            <li key={e.sha} className="flex items-baseline gap-2">
              <span className="font-code text-[11px] text-accent tabular-nums">
                {e.sha.slice(0, 7)}
              </span>
              <span className="text-ink text-[12.5px] truncate min-w-0 flex-1">
                {e.subject}
              </span>
              {e.author && (
                <span className="text-muted text-[10.5px] whitespace-nowrap">
                  {e.author.replace(/ <[^>]+>$/, '')}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
})

// ---------------------------------------------------------------------------
// GitPushCard
// ---------------------------------------------------------------------------

export const GitPushCard = memo(function GitPushCard({
  intent,
  output,
}: {
  intent: Extract<GitIntent, { kind: 'push' }>
  output: string
}) {
  const r = useMemo(() => parseGitPush(stripAnsi(output)), [output])
  return (
    <Card>
      <GitCardHeader
        sub={intent.force ? 'push --force' : 'push'}
        badges={r.remoteUrl && (
          <span className="font-code text-[10.5px] text-muted truncate max-w-[240px]">
            {r.remoteUrl}
          </span>
        )}
      />
      {r.upToDate ? (
        <div className="text-muted text-[12px] italic">everything up to date</div>
      ) : r.refs.length === 0 ? (
        <pre className="font-code text-[11.5px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-words m-0">
          {stripAnsi(output).trim() || '(no output)'}
        </pre>
      ) : (
        <ul className="list-none p-0 m-0 flex flex-col gap-0.5">
          {r.refs.map((rf, i) => (
            <li key={i} className="flex items-baseline gap-2 font-code text-[12px]">
              <span className="text-accent">{rf.ref}</span>
              <span className="text-ink-dim">·</span>
              <span className="text-ink-dim tabular-nums">{rf.range}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
})

// ---------------------------------------------------------------------------
// Dispatcher — pick the right card for an intent
// ---------------------------------------------------------------------------

export function renderGitCard(intent: GitIntent, output: string): React.ReactNode {
  switch (intent.kind) {
    case 'diff':   return <GitDiffCard intent={intent} output={output} />
    case 'commit': return <GitCommitCard intent={intent} output={output} />
    case 'status': return <GitStatusCard intent={intent} output={output} />
    case 'add':    return <GitAddCard intent={intent} output={output} />
    case 'log':    return <GitLogCard intent={intent} output={output} />
    case 'push':   return <GitPushCard intent={intent} output={output} />
    default: return null
  }
}

/**
 * Wrap a git card in the marker-band wrapper used for Claude tool
 * rows so the card aligns with the feed's marker gutter and gets
 * the same left ornament. Keeps the git widgets visually in the
 * same lane as Edit/MultiEdit/Write rows.
 */
export function GitCardRow({ intent, output }: { intent: GitIntent; output: string }) {
  return (
    <MarkerRow marker="⏺">
      {renderGitCard(intent, output)}
    </MarkerRow>
  )
}
