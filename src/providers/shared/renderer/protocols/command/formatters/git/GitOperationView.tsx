// Rich Git operation rendering owned by the shared command protocol.
//
// Provider adapters prove their own Bash/exec envelopes before reaching this
// view. The operation boundary then supplies the exact paired result, so the
// view and result absorption cannot drift into two separate name checks.
//
// The provider-owned operation route renders this surface on the tool-use row
// and explicitly absorbs the paired result row. That absorption is safe only
// because this component owns BOTH the structured summary and a lazy view of
// the exact raw result. Provider adapters prove their Bash/exec envelope;
// detect.ts proves the command is conservatively classifiable; the parsers here
// are presentation enrichment and never become the sole surviving evidence.
//
// Git diff hunks use a dedicated slab instead of the generic code-edit slab:
// they need per-hunk headers and per-file disclosure state. The visual grammar
// is shared, but forcing the richer Git topology into the code-edit model would
// make that supposedly neutral protocol understand Git wire structure.

import { memo, useMemo, useState } from 'react'
import hljs from 'highlight.js'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
import { boundedTextPage } from '@renderer/lib/text/boundedText'
import { escapeHtml, toHighlightLanguage } from '@shared/code/htmlHighlight'
import { normalizeCodeLanguage } from '@shared/code/language'
import { CommandView } from '@providers/shared/renderer/protocols/command/CommandView'
import type { GitIntent, GitWorkflowIntent } from './detect'
import type { GitOperationModel } from './model'
import {
  parseGitCommit,
  parseGitLog,
  parseGitPush,
  parseGitStatus,
  parseUnifiedDiff,
  stripAnsi,
} from './parse'
import type { GitDiffFile, GitDiffLine } from './parse'

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
      {flags?.map((f, index) => (
        <span
          key={`${index}:${f}`}
          className="font-code text-[11px] text-code-ink-dim bg-code-bg px-1.5 py-0.5 rounded"
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

function PlusMinus({
  added,
  removed,
  partial = false,
}: {
  added: number
  removed: number
  partial?: boolean
}) {
  return (
    <span className="font-code text-[11px] tabular-nums whitespace-nowrap">
      <span className="text-diff-add-fg">+{partial ? '≥' : ''}{added}</span>
      <span className="text-ink-dim"> / </span>
      <span className="text-diff-remove-fg">-{partial ? '≥' : ''}{removed}</span>
    </span>
  )
}

function PartialPreviewNotice({ children }: { children?: React.ReactNode }) {
  return (
    <div className="text-muted text-[11px] mt-1.5">
      {children ?? 'Structured preview is partial; exact output continues below.'}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Diff hunk renderer
// ---------------------------------------------------------------------------

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
function FileBlock({ file, countsPartial = false }: { file: GitDiffFile; countsPartial?: boolean }) {
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
        <PlusMinus added={file.added} removed={file.removed} partial={countsPartial} />
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
  partial = false,
}: {
  intent: Extract<GitIntent, { kind: 'diff' }>
  output: string
  partial?: boolean
}) {
  // WHY parse before the raw-mode branch despite `--stat`/`--name-only` not
  // consuming this result: intent can change on an existing React row while
  // streaming/provider normalization settles. A hook below the branch makes
  // that legitimate props transition change the component's hook count and
  // crash reconciliation. The input has already passed the strict one-page
  // admission cap, so the small redundant parse is bounded and preferable to
  // splitting identity across child component types.
  const parsed = useMemo(
    () => parseUnifiedDiff(stripAnsi(output)),
    [output],
  )

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
        {partial ? <PartialPreviewNotice /> : null}
      </Card>
    )
  }

  const { files, added, removed } = parsed

  // Empty diff (no changes): often `git diff` with clean workspace.
  // Show a small "no changes" muted note instead of a silent card.
  if (files.length === 0) {
    return (
      <Card>
        <GitCardHeader sub="diff" flags={intent.flags} paths={intent.paths} />
        <div className="text-muted text-[12px] italic">
          {partial ? '(no complete diff entries in bounded preview)' : '(no changes)'}
        </div>
        {partial ? <PartialPreviewNotice /> : null}
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
              {partial ? '≥' : ''}{files.length} file{files.length === 1 ? '' : 's'}
            </span>
            <PlusMinus added={added} removed={removed} partial={partial} />
          </span>
        }
      />
      <div className="flex flex-col gap-1">
        {files.map((f, index) => (
          <FileBlock
            // Repeated path blocks are legal in concatenated/show output.
            // The ordinal makes sibling identity unique without pretending
            // path text is a primary key; successful Git cards do not reorder.
            key={`${index}:${f.oldPath ?? ''}:${f.path}`}
            file={f}
            countsPartial={partial && index === files.length - 1}
          />
        ))}
      </div>
      {partial ? (
        <PartialPreviewNotice>
          Counts are proven lower bounds from the parsed prefix; exact output continues below.
        </PartialPreviewNotice>
      ) : null}
    </Card>
  )
})

// ---------------------------------------------------------------------------
// GitCommitCard
// ---------------------------------------------------------------------------

export const GitCommitCard = memo(function GitCommitCard({
  intent,
  output,
  partial = false,
}: {
  intent: Extract<GitIntent, { kind: 'commit' }>
  output: string
  partial?: boolean
}) {
  const result = useMemo(() => parseGitCommit(stripAnsi(output)), [output])

  // A no-op line in a bounded prefix may belong to an earlier `git status`
  // in an admitted all-Git chain, with the successful header beyond the page.
  // Only a complete output can turn negative advice into the card verdict.
  if (result.noop && !partial) {
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
              <span className="font-code text-[11px] text-code-ink-dim bg-code-bg px-1.5 py-0.5 rounded">
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
      {partial ? <PartialPreviewNotice /> : null}
    </Card>
  )
})

// ---------------------------------------------------------------------------
// GitStatusCard
// ---------------------------------------------------------------------------

export const GitStatusCard = memo(function GitStatusCard({
  output,
  partial = false,
}: {
  intent: Extract<GitIntent, { kind: 'status' }>
  output: string
  partial?: boolean
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
          <span className="font-code text-[11px] text-code-ink-dim bg-code-bg px-1.5 py-0.5 rounded">
            {r.branch}
          </span>
        )}
      />
      {!anyEntries && (
        <div className="text-muted text-[12px] italic">
          {partial ? 'no complete status entries in bounded preview' : 'working tree clean'}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {sections.map(s => s.entries.length > 0 && (
          <div key={s.title}>
            <div className="text-muted text-[10px] uppercase tracking-wider mb-0.5">
              {s.title} ({partial ? '≥' : ''}{s.entries.length})
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
      {partial ? (
        <PartialPreviewNotice>
          Status counts cover only the parsed prefix; exact output continues below.
        </PartialPreviewNotice>
      ) : null}
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
  partial = false,
}: {
  intent: Extract<GitIntent, { kind: 'add' }>
  output: string
  partial?: boolean
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
              {intent.paths.map((p, index) => (
                <li key={`${index}:${p}`} className="font-code text-[12px] text-ink">{p}</li>
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
      {partial ? <PartialPreviewNotice /> : null}
    </Card>
  )
})

// ---------------------------------------------------------------------------
// GitLogCard
// ---------------------------------------------------------------------------

export const GitLogCard = memo(function GitLogCard({
  intent,
  output,
  partial = false,
}: {
  intent: Extract<GitIntent, { kind: 'log' }>
  output: string
  partial?: boolean
}) {
  const entries = useMemo(() => {
    const parsed = parseGitLog(stripAnsi(output))
    // One-line records are complete once their newline is admitted. Full log
    // records end only when the next `commit` header arrives, so the final
    // parsed block in a bounded prefix may be only a SHA/author fragment.
    // Drop that uncertain block rather than counting/displaying it as a
    // complete commit; every preceding block has a following header proving
    // its boundary. The raw disclosure retains the omitted tail.
    return partial && !intent.oneline ? parsed.slice(0, -1) : parsed
  }, [intent.oneline, output, partial])
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
        <div className="text-muted text-[12px] italic">
          {partial ? '(no complete log entries in bounded preview)' : '(no commits)'}
        </div>
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
      {partial ? (
        <PartialPreviewNotice>
          Showing {entries.length} complete commit{entries.length === 1 ? '' : 's'} from the parsed prefix; exact output continues below.
        </PartialPreviewNotice>
      ) : null}
    </Card>
  )
})

// ---------------------------------------------------------------------------
// GitPushCard
// ---------------------------------------------------------------------------

export const GitPushCard = memo(function GitPushCard({
  intent,
  output,
  partial = false,
}: {
  intent: Extract<GitIntent, { kind: 'push' }>
  output: string
  partial?: boolean
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
      {partial ? <PartialPreviewNotice /> : null}
    </Card>
  )
})

// ---------------------------------------------------------------------------
// Dispatcher — pick the right card for an intent
// ---------------------------------------------------------------------------

function workflowTitle(intent: GitWorkflowIntent): string {
  if (intent.steps.length === 1) return intent.primaryVerb
  switch (intent.primaryVerb) {
    case 'apply': return intent.steps.some(step => step.verb === 'diff')
      ? 'diff and apply'
      : 'apply workflow'
    case 'stash': return 'stash and verify'
    case 'reset': return 'reset and inspect'
    case 'add': return 'stage and verify'
    case 'fetch': return 'fetch and inspect'
    default: return `${intent.primaryVerb} workflow`
  }
}

/** Bound for the workflow card's INLINE output slab. The full page budget
 * (16 KB / 400 lines) is a parser admission cap, not a card layout; a chain
 * that dumps a large diff would visually drown the step list. The complete
 * exact output always remains one click away in GitOutputDisclosure. */
const WORKFLOW_INLINE_OUTPUT_CHARS = 2048
const WORKFLOW_INLINE_OUTPUT_LINES = 40

/**
 * Generic card for all-Git chains and broader single verbs.
 *
 * This card also renders for an unknown-exit all-Git workflow, but in a
 * deliberately neutral state. Unlike the verb-specific cards, it does not
 * interpret an empty stream as "clean" or "no changes": it lists commands
 * and exact output. Only proven exit 0 can legitimize completion/checkmarks.
 *
 * Summary discipline: every summary line must be ANCHORED — either a verbatim
 * output line whose grammar is unique to one step, or the product of a parser
 * gated on that step's presence. Heuristics that guessed from position or
 * loose regexes ("HEAD matches origin/main" from the first two hex lines,
 * changed-path counts from two-letter prefixes, reset-mode claims derived
 * from the command STRING rather than output) asserted false facts and were
 * removed. Prefer dropping an enrichment over guessing: the steps, the
 * bounded output, and the raw disclosure are the evidence; summaries only
 * restate what they already prove.
 */
function GitWorkflowCard({
  intent,
  output,
  partial,
  status,
}: {
  intent: GitWorkflowIntent
  output: string
  partial: boolean
  status: 'success' | 'unknown'
}) {
  const plain = stripAnsi(output)
  const lines = plain.replace(/\r\n?/g, '\n').split('\n')
  // `&&` + proven exit 0 is the only combination that proves every step ran
  // AND succeeded. A `;`/newline chain exits with the LAST segment's status,
  // so even proven success leaves earlier steps unaccounted for — those render
  // neutral bullets and no "complete" badge.
  const allStepsProven = status === 'success' &&
    intent.operators.every(operator => operator === '&&')
  // Stash identity: only claim a `stash@{n}:` line when the output contains
  // exactly one. A chain ending in a multi-entry `git stash list` has several,
  // and picking any one of them would misattribute which stash this operation
  // touched.
  const stashLines = lines.map(line => line.trim()).filter(line => /^stash@\{\d+\}:/.test(line))
  const stashRef = intent.steps.some(step => step.verb === 'stash') && stashLines.length === 1
    ? stashLines[0]
    : undefined
  // Branch: requires a `status --branch` step (the only admitted step that
  // emits the porcelain `## <branch>` header) AND exactly one candidate line.
  // Other admitted verbs (`show`, `log`) can print arbitrary text including
  // markdown headings; uniqueness plus the emitting step keeps this anchored.
  const hasBranchStatusStep = intent.steps.some(step =>
    step.verb === 'status' && /(?:^|\s)(?:--branch|-b)\b/.test(step.args),
  )
  const branchLines = lines.filter(line => /^##\s+\S/.test(line))
  const branch = hasBranchStatusStep && branchLines.length === 1
    ? branchLines[0].replace(/^##\s+/, '').trim()
    : undefined
  const commit = intent.steps.some(step => step.verb === 'commit')
    ? parseGitCommit(plain)
    : null
  const commitStats = commit?.filesChanged !== undefined
    ? [
        `${commit.filesChanged.toLocaleString()} ${commit.filesChanged === 1 ? 'file' : 'files'}`,
        commit.insertions !== undefined ? `+${commit.insertions.toLocaleString()}` : null,
        commit.deletions !== undefined ? `-${commit.deletions.toLocaleString()}` : null,
      ].filter((part): part is string => part !== null).join(' · ')
    : null
  const push = intent.steps.some(step => step.verb === 'push')
    ? parseGitPush(plain)
    : null
  const summaries = [
    stashRef,
    commit?.sha ? `${commit.sha}  ${commit.subject ?? 'commit created'}` : null,
    commitStats,
    push?.upToDate ? 'Everything already up to date' : null,
    push && push.refs.length > 0 ? push.refs.map(ref => ref.ref).join(', ') : null,
    branch ? `Branch ${branch}` : null,
  ].filter((summary): summary is string => summary !== null && summary !== undefined)
  // Inline output keeps broader verbs useful: `git branch -a`, `git show`,
  // `git stash list` were previously collapsed to their first line, hiding
  // everything but one row behind the disclosure toggle. A second, tighter
  // page keeps the card scannable while the raw disclosure retains all bytes.
  const inline = boundedTextPage(
    plain.trim(),
    0,
    WORKFLOW_INLINE_OUTPUT_CHARS,
    WORKFLOW_INLINE_OUTPUT_LINES,
  )

  return (
    <Card>
      <GitCardHeader
        sub={workflowTitle(intent)}
        badges={allStepsProven
          ? <span className="text-[10.5px] uppercase tracking-wide text-muted">complete</span>
          : status === 'unknown'
            ? <span className="text-[10.5px] uppercase tracking-wide text-muted">exit unknown</span>
            : null}
      />
      {summaries.length > 0 ? (
        <div className="flex flex-col gap-0.5 mb-2 text-[12px] text-ink-dim">
          {summaries.map(summary => <div key={summary}>{summary}</div>)}
        </div>
      ) : null}
      <ol className="list-none p-0 m-0 flex flex-col gap-0.5">
        {intent.steps.map((step, index) => (
          <li key={`${index}:${step.command}`} className="flex items-baseline gap-2 min-w-0">
            <span className={allStepsProven ? 'text-success' : 'text-muted'}>
              {allStepsProven ? '✓' : '•'}
            </span>
            <span className="font-code text-[11.5px] text-ink-dim truncate" title={step.command}>
              {step.command}
            </span>
          </li>
        ))}
      </ol>
      <pre className="font-code text-[11.5px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-words m-0 mt-2">
        {inline.text ? `${inline.text}${inline.hasNext ? '\n…' : ''}` : '(no output)'}
      </pre>
      {partial ? <PartialPreviewNotice /> : null}
    </Card>
  )
}

export function renderGitCard(
  intent: GitIntent,
  output: string,
  status: 'success' | 'unknown' = 'success',
): React.ReactNode {
  // WHY custom git cards enforce the same admission budget as generic tool
  // output: the parsers split output into files/hunks/lines and the diff card
  // highlights each line. A huge `git diff` therefore bypassed CodeBlock's
  // protections and could synchronously create thousands of highlighted DOM
  // rows. Parse one bounded page; the complete durable output remains
  // available through an explicitly opened paged raw viewer.
  const page = boundedTextPage(output)
  // A character-bounded page may end halfway through a Git record. Feeding
  // that suffix to regex parsers can manufacture facts from a prefix (for
  // example, `1 file changed, 2 inser` used to become +0). Keep every complete
  // line; drop only the unfinished tail. The exact source is still retained by
  // GitOutputDisclosure, so this is parser admission rather than data loss.
  const parseableOutput = completeLinesFromBoundedPage(page.text, page.hasNext)
  const card = (() => {
    switch (intent.kind) {
      case 'diff':   return <GitDiffCard intent={intent} output={parseableOutput} partial={page.hasNext} />
      case 'commit': return <GitCommitCard intent={intent} output={parseableOutput} partial={page.hasNext} />
      case 'status': return <GitStatusCard intent={intent} output={parseableOutput} partial={page.hasNext} />
      case 'add':    return <GitAddCard intent={intent} output={parseableOutput} partial={page.hasNext} />
      case 'log':    return <GitLogCard intent={intent} output={parseableOutput} partial={page.hasNext} />
      case 'push':   return <GitPushCard intent={intent} output={parseableOutput} partial={page.hasNext} />
      case 'workflow': return (
        <GitWorkflowCard
          intent={intent}
          output={parseableOutput}
          partial={page.hasNext}
          status={status}
        />
      )
      default: return null
    }
  })()
  return (
    <>
      {card}
      {/* WHY this disclosure is unconditional, even when the parser consumed
          every familiar line: Git writes warnings, advice, hook output, and
          remote messages beside otherwise valid status/diff/push output. The
          specialized parser intentionally ignores those open-world lines.
          Since the paired result row is absorbed, omitting this lazy exact
          source would make the rich card less truthful than the generic
          fallback. PagedTextViewer mounts only on open, so the collapsed cost
          remains constant for both short and enormous results. */}
      <GitOutputDisclosure output={output} />
    </>
  )
}

function completeLinesFromBoundedPage(text: string, hasNext: boolean): string {
  if (!hasNext || text.endsWith('\n')) return text
  const lastNewline = text.lastIndexOf('\n')
  return lastNewline < 0 ? '' : text.slice(0, lastNewline + 1)
}

function GitOutputDisclosure({ output }: { output: string }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="mt-1 text-[11px] text-muted"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer hover:text-ink">
        view raw output · {output.length.toLocaleString()} characters
      </summary>
      {open ? <div className="mt-1"><PagedTextViewer source={output} /></div> : null}
    </details>
  )
}

/**
 * Wrap a git card in the marker-band wrapper used for Claude tool
 * rows so the card aligns with the feed's marker gutter and gets
 * the same left ornament. Keeps the git widgets visually in the
 * same lane as Edit/MultiEdit/Write rows.
 */
export function GitCardRow({
  intent,
  output,
  status = 'success',
}: {
  intent: GitIntent
  output: string
  status?: 'success' | 'unknown'
}) {
  return (
    <MarkerRow marker="⏺">
      {renderGitCard(intent, output, status)}
    </MarkerRow>
  )
}

/**
 * One paired Git operation surface.
 *
 * Failed commands and unknown-exit single verbs deliberately stay in the
 * ordinary command grammar. Git's verb-specific parsers are best-effort and
 * could turn an authentication error into an empty/clean-looking card. An
 * all-Git workflow is different: its card makes no verb-specific result claim,
 * keeps every step and raw byte visible, and can therefore improve structure
 * under an unknown exit as long as it remains visibly neutral.
 */
export function GitOperationView({ model }: { model: GitOperationModel }) {
  if (model.status === 'unknown' && model.intent.kind === 'workflow') {
    return (
      <GitCardRow
        intent={model.intent}
        output={model.output ?? ''}
        status="unknown"
      />
    )
  }
  if (model.status !== 'success') {
    const firstLine = model.output?.split('\n', 1)[0]?.slice(0, 200)
    const commandPage = boundedTextPage(model.command, 0, 160, 2)
    // Provider Git adapters intentionally retain the full command for intent
    // proof. CommandView, however, syntax-highlights its headline under the
    // invariant that adapters already bounded it. This operation-specific
    // bridge must enforce that same limit or a failed megabyte command can
    // synchronously enter highlight.js before OutputWell gets a chance to
    // bound anything.
    const boundedCommand = commandPage.hasNext ? `${commandPage.text}…` : commandPage.text
    return (
      <CommandView
        model={{
          label: 'Git',
          command: boundedCommand,
          status: model.status,
          exitCode: null,
          output: model.output,
          outputIsError: model.status === 'failure',
          errorSummary: model.status === 'failure'
            ? firstLine || 'Git command failed'
            : undefined,
        }}
      />
    )
  }
  return <GitCardRow intent={model.intent} output={model.output ?? ''} />
}
