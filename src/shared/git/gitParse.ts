// Parsers for raw git stdout → structured data the widgets can render.
//
// Each function is pure, takes the raw text of a git command's output,
// and returns a typed shape. None of them throw — on an unexpected
// format they return a best-effort partial result, and the widget
// falls back to showing the raw text where the structured data is
// missing. That way the custom-rendering toggle can't regress us
// below the generic renderer's baseline.
//
// Kept separate from gitDetect.ts because detection is cheap/always
// runs and parsing is opt-in per widget.

// --- Unified diff parser ---------------------------------------------------

export type GitDiffLine = {
  kind: '+' | '-' | 'ctx'
  text: string
}

export type GitDiffHunk = {
  /** The `@@ -a,b +c,d @@` header line (no context after the closing @@). */
  header: string
  /** Old-file start line (1-indexed). */
  oldStart: number
  /** New-file start line. */
  newStart: number
  lines: GitDiffLine[]
}

export type GitDiffFile = {
  /** Path relative to repo root. Prefer the `+++` (new) path if it
   *  differs from the `---` (old) path — the new path is the one the
   *  user sees after the change lands. For deletes, new path is
   *  `/dev/null` and we fall back to the old path. */
  path: string
  /** Previous path if this file was renamed. null if not a rename. */
  oldPath: string | null
  /** Rough line counts; computed from the hunk bodies so they match
   *  the actual rendered diff, not the optional `--stat` summary. */
  added: number
  removed: number
  /** True when the diff header indicates this file is binary — no
   *  hunks will be present. */
  binary: boolean
  /** True when the file was newly created. */
  created: boolean
  /** True when the file was deleted. */
  deleted: boolean
  hunks: GitDiffHunk[]
}

export type GitDiffResult = {
  files: GitDiffFile[]
  /** Total insertions across all files. */
  added: number
  /** Total deletions across all files. */
  removed: number
}

/**
 * Parse unified-diff output (git diff / git show). The format we
 * accept is the standard one each file block opens with:
 *
 *   diff --git a/path/to/foo.ts b/path/to/foo.ts
 *   index abc1234..def5678 100644
 *   --- a/path/to/foo.ts
 *   +++ b/path/to/foo.ts
 *   @@ -12,6 +12,9 @@ surrounding context
 *   - removed
 *   + added
 *     context
 *
 * Everything else (`new file mode`, `deleted file mode`, `rename
 * from/to`, `Binary files … differ`) is recognized at the file-header
 * level and surfaced as flags.
 */
export function parseUnifiedDiff(text: string): GitDiffResult {
  const files: GitDiffFile[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let i = 0

  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git ')) { i++; continue }

    // --- File header block -------------------------------------------------
    const file: GitDiffFile = {
      path: '',
      oldPath: null,
      added: 0,
      removed: 0,
      binary: false,
      created: false,
      deleted: false,
      hunks: [],
    }

    // Peel off the `a/foo` `b/foo` pair from the `diff --git` line as
    // an initial best-guess path. The `---`/`+++` lines below, if
    // present, supersede this.
    const dg = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[i])
    if (dg) {
      file.oldPath = dg[1]
      file.path = dg[2]
    }
    i++

    // Consume optional metadata lines until we hit a hunk header or
    // the next file.
    while (i < lines.length && !lines[i].startsWith('@@ ')
                          && !lines[i].startsWith('diff --git ')) {
      const line = lines[i]
      if (line.startsWith('new file mode')) file.created = true
      else if (line.startsWith('deleted file mode')) file.deleted = true
      else if (line.startsWith('rename from ')) file.oldPath = line.slice(12)
      else if (line.startsWith('rename to ')) file.path = line.slice(10)
      else if (line.startsWith('--- ')) {
        const p = line.slice(4)
        if (p !== '/dev/null' && p.startsWith('a/')) file.oldPath = p.slice(2)
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4)
        if (p !== '/dev/null' && p.startsWith('b/')) file.path = p.slice(2)
      } else if (line.startsWith('Binary files ')) {
        file.binary = true
      }
      i++
    }

    // For deletes, `+++ /dev/null` leaves file.path unchanged from the
    // diff --git header; keep the old path as the display path.
    if (!file.path && file.oldPath) file.path = file.oldPath
    if (!file.oldPath) file.oldPath = null

    // --- Hunks -------------------------------------------------------------
    while (i < lines.length && lines[i].startsWith('@@ ')) {
      const hh = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[i])
      const hunk: GitDiffHunk = {
        header: lines[i],
        oldStart: hh ? parseInt(hh[1], 10) : 0,
        newStart: hh ? parseInt(hh[2], 10) : 0,
        lines: [],
      }
      i++
      while (i < lines.length
             && !lines[i].startsWith('@@ ')
             && !lines[i].startsWith('diff --git ')) {
        const line = lines[i]
        // Git emits a trailing '\ No newline at end of file' note on
        // files without a final LF. Surface it as a context line so
        // the user sees it without it polluting the counters.
        if (line.startsWith('\\ ')) {
          hunk.lines.push({ kind: 'ctx', text: line })
          i++; continue
        }
        if (line.startsWith('+')) {
          hunk.lines.push({ kind: '+', text: line.slice(1) })
          file.added++
        } else if (line.startsWith('-')) {
          hunk.lines.push({ kind: '-', text: line.slice(1) })
          file.removed++
        } else {
          // Either ' context' or an empty line (an entirely blank
          // context row renders as a zero-char line, no leading space).
          hunk.lines.push({ kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line })
        }
        i++
      }
      file.hunks.push(hunk)
    }

    files.push(file)
  }

  const added = files.reduce((sum, f) => sum + f.added, 0)
  const removed = files.reduce((sum, f) => sum + f.removed, 0)
  return { files, added, removed }
}

// --- git status parser -----------------------------------------------------

export type GitStatusEntry = {
  /** Single-letter code: M/A/D/R/C/U/? */
  code: string
  /** Display path (new path for renames). */
  path: string
  /** Old path, if this is a rename/copy. */
  oldPath?: string
}

export type GitStatusResult = {
  branch?: string
  staged: GitStatusEntry[]
  modified: GitStatusEntry[]
  untracked: GitStatusEntry[]
}

/**
 * Parse `git status` output — both regular and porcelain/short forms.
 * Porcelain is unambiguous; the regular form uses section headers and
 * change-type labels ("modified:", "new file:", "deleted:"). We parse
 * whichever the output looks like.
 */
export function parseGitStatus(text: string): GitStatusResult {
  const out: GitStatusResult = { staged: [], modified: [], untracked: [] }
  const lines = text.replace(/\r\n?/g, '\n').split('\n')

  // Porcelain detection: every non-empty line begins with two status
  // columns (any of " MADRCU?!") then a space then the path.
  const porcelainRe = /^([ MADRCU?!])([ MADRCU?!]) (.+)$/
  const looksPorcelain = lines.some(l => porcelainRe.test(l))
           && !lines.some(l => /^On branch /.test(l))

  if (looksPorcelain) {
    for (const l of lines) {
      const m = porcelainRe.exec(l)
      if (!m) continue
      const [, index, worktree, pathRest] = m
      // Rename: "R  old -> new". `pathRest` contains both paths.
      let path = pathRest
      let oldPath: string | undefined
      const arrow = pathRest.indexOf(' -> ')
      if (arrow >= 0) {
        oldPath = pathRest.slice(0, arrow)
        path = pathRest.slice(arrow + 4)
      }
      if (index !== ' ' && index !== '?') {
        out.staged.push({ code: index, path, oldPath })
      }
      if (worktree !== ' ' && worktree !== '?') {
        out.modified.push({ code: worktree, path, oldPath })
      }
      if (index === '?' || worktree === '?') {
        out.untracked.push({ code: '?', path })
      }
    }
    return out
  }

  // Regular form: parse section headers.
  let section: 'staged' | 'modified' | 'untracked' | null = null
  for (const l of lines) {
    const onBranch = /^On branch (.+)$/.exec(l)
    if (onBranch) { out.branch = onBranch[1]; continue }
    if (/^Changes to be committed:/.test(l)) { section = 'staged'; continue }
    if (/^Changes not staged for commit:/.test(l)) { section = 'modified'; continue }
    if (/^Untracked files:/.test(l)) { section = 'untracked'; continue }
    if (!section) continue
    // "\tmodified:   path" / "\tnew file:   path" / "\tdeleted:    path"
    const labeled = /^\t(modified|new file|deleted|renamed|copied|typechange):\s+(.+)$/.exec(l)
    if (labeled) {
      const code = labeled[1] === 'new file' ? 'A'
                 : labeled[1] === 'modified' ? 'M'
                 : labeled[1] === 'deleted' ? 'D'
                 : labeled[1] === 'renamed' ? 'R'
                 : labeled[1] === 'copied' ? 'C'
                 : 'T'
      let path = labeled[2]
      let oldPath: string | undefined
      const arrow = path.indexOf(' -> ')
      if (arrow >= 0) {
        oldPath = path.slice(0, arrow)
        path = path.slice(arrow + 4)
      }
      if (section === 'staged') out.staged.push({ code, path, oldPath })
      else if (section === 'modified') out.modified.push({ code, path, oldPath })
      continue
    }
    // Untracked files are printed raw (one per line, tab-indented).
    if (section === 'untracked') {
      const u = /^\t(.+)$/.exec(l)
      if (u) out.untracked.push({ code: '?', path: u[1] })
    }
  }
  return out
}

// --- git commit output parser ---------------------------------------------

export type GitCommitResult = {
  branch?: string
  /** Short hash from the `[branch sha]` header. */
  sha?: string
  subject?: string
  body?: string
  filesChanged?: number
  insertions?: number
  deletions?: number
  /** True when stdout contained "nothing to commit" or a similar
   *  no-op message — we surface this so the widget can render a
   *  muted "no changes" variant instead of a success card. */
  noop: boolean
}

/**
 * Parse `git commit` stdout. Happy-path format:
 *
 *   [main a119043] fix: forward Codex trust-dialog + activity status
 *    Three review findings, all real...
 *    6 files changed, 63 insertions(+), 22 deletions(-)
 *
 * The subject lives on the header line; the body is the group of
 * subsequent indented lines; the stats are on the "N files changed"
 * line that git always emits last.
 */
export function parseGitCommit(text: string): GitCommitResult {
  const result: GitCommitResult = { noop: false }
  const lines = text.replace(/\r\n?/g, '\n').split('\n')

  if (/nothing to commit|no changes added/i.test(text)) {
    result.noop = true
    return result
  }

  const headerRe = /^\[([^\s\]]+)(?:\s+\(root-commit\))?\s+([0-9a-f]{7,40})\]\s*(.*)$/
  let i = 0
  for (; i < lines.length; i++) {
    const m = headerRe.exec(lines[i])
    if (!m) continue
    result.branch = m[1]
    result.sha = m[2]
    result.subject = m[3].trim() || undefined
    i++
    break
  }

  // Body: indented lines before the stats line. Stop when we hit the
  // "N files changed" summary or a blank run followed by non-indented text.
  const bodyLines: string[] = []
  for (; i < lines.length; i++) {
    const l = lines[i]
    const stats = /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(l)
    if (stats) {
      result.filesChanged = parseInt(stats[1], 10)
      if (stats[2]) result.insertions = parseInt(stats[2], 10)
      if (stats[3]) result.deletions = parseInt(stats[3], 10)
      break
    }
    if (l.startsWith(' ')) bodyLines.push(l.replace(/^\s/, ''))
  }
  if (bodyLines.length > 0) result.body = bodyLines.join('\n').trim()

  return result
}

// --- git log parser --------------------------------------------------------

export type GitLogEntry = {
  sha: string
  subject: string
  author?: string
  date?: string
}

/**
 * Parse `git log` output. We support two flavors:
 *   - --oneline: "sha subject"
 *   - full: blocks with "commit sha", "Author: ...", "Date: ...",
 *     blank line, indented subject, blank line, etc.
 *
 * Bails (returns empty list) on exotic --format strings — those are
 * unlikely in agent output but would need their own mini-parser.
 */
export function parseGitLog(text: string): GitLogEntry[] {
  const entries: GitLogEntry[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')

  // --oneline form: every non-empty line starts with a hex sha.
  const onelineRe = /^([0-9a-f]{7,40})\s+(.+)$/
  const allOneline = lines.every(l => l === '' || onelineRe.test(l))
  if (allOneline && lines.some(l => onelineRe.test(l))) {
    for (const l of lines) {
      const m = onelineRe.exec(l)
      if (m) entries.push({ sha: m[1], subject: m[2] })
    }
    return entries
  }

  // Full form.
  let cur: GitLogEntry | null = null
  let inSubjectBlock = false
  for (const l of lines) {
    const commit = /^commit ([0-9a-f]{7,40})/.exec(l)
    if (commit) {
      if (cur) entries.push(cur)
      cur = { sha: commit[1], subject: '' }
      inSubjectBlock = false
      continue
    }
    if (!cur) continue
    const author = /^Author:\s*(.+)$/.exec(l)
    if (author) { cur.author = author[1]; continue }
    const date = /^Date:\s*(.+)$/.exec(l)
    if (date) { cur.date = date[1]; continue }
    if (l === '' && !inSubjectBlock && !cur.subject) { inSubjectBlock = true; continue }
    if (inSubjectBlock && !cur.subject) {
      cur.subject = l.replace(/^\s{4}/, '')
      inSubjectBlock = false
    }
  }
  if (cur) entries.push(cur)
  return entries
}

// --- git push parser -------------------------------------------------------

export type GitPushResult = {
  /** "origin/main" → "a119043..07390a0" style ref updates. */
  refs: Array<{ ref: string; range: string }>
  remoteUrl?: string
  /** True when output indicates "Everything up-to-date". */
  upToDate: boolean
}

/**
 * Parse `git push` output. The important lines look like:
 *
 *   To https://github.com/x/y.git
 *      a119043..07390a0  main -> main
 *
 * Everything else (pack stats, compression ratios) we ignore — the
 * interesting signal is "did anything change, and for which branch".
 */
export function parseGitPush(text: string): GitPushResult {
  const result: GitPushResult = { refs: [], upToDate: false }
  if (/Everything up-to-date/.test(text)) result.upToDate = true
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (const l of lines) {
    const to = /^To\s+(.+)$/.exec(l)
    if (to) { result.remoteUrl = to[1]; continue }
    // "   a119043..07390a0  main -> main"
    const ref = /^\s+([0-9a-f]{7,40}\.\.[0-9a-f]{7,40}|\[new branch\]|\[deleted\])\s+(.+)$/.exec(l)
    if (ref) result.refs.push({ range: ref[1], ref: ref[2].trim() })
  }
  return result
}

// --- strip ANSI color codes ------------------------------------------------

/**
 * Agents sometimes run git with color output on (or git picks up a
 * global `color.ui=always`). Our parsers expect plain text. Strip
 * SGR escapes before parsing — cheaper than adding color tolerance
 * to every parser.
 */
export function stripAnsi(text: string): string {
  // Match ESC[...m SGR sequences only. Broader CSI patterns aren't
  // common in git output and leaving them untouched is harmless.
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}
