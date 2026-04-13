// Detect git intent from a raw shell command string.
//
// Both Claude (Bash tool) and Codex (exec_command) hand us a single
// command string as the user typed it. We need to decide:
//   - Is this a git invocation we have a custom widget for?
//   - Which subcommand + flags did they use?
//   - What paths did they pass?
//
// Heuristic, not a shell parser. We care about the common shapes
// agents actually emit ("git diff", "git diff --staged", "git
// commit -m ...", "git add .", "git status", "git log --oneline
// -5"). Anything exotic (pipes, subshells, aliases, `git -C <dir>`
// invocations, `git config`, unknown subcommands) returns null so
// the feed falls back to the generic tool renderer. A missed
// detection is always safer than a wrong one.

export type GitDiffIntent = {
  kind: 'diff'
  /** Flags that were passed (--staged, --cached, --name-only, etc.). */
  flags: string[]
  /** Paths that followed `--` (or positional after flags). */
  paths: string[]
  /** Whether this is a staged/cached diff. */
  staged: boolean
  /** Whether name-only mode — output is a flat file list, not a diff. */
  nameOnly: boolean
  /** Whether --stat was passed — output is a per-file summary table. */
  stat: boolean
}

export type GitCommitIntent = {
  kind: 'commit'
  /** The `-m` / `--message` payload if we could pull it out. Heredoc
   *  commits typically set this via a shell heredoc which our parser
   *  doesn't try to reconstruct — we leave `message` undefined and
   *  let the widget fall back to parsing the committed subject out
   *  of the commit output instead. */
  message?: string
  /** Whether --amend was set. */
  amend: boolean
}

export type GitStatusIntent = {
  kind: 'status'
  /** --short / -s or --porcelain. Changes parsing strategy for the
   *  result, but both produce a categorized list the widget can use. */
  porcelain: boolean
}

export type GitAddIntent = {
  kind: 'add'
  /** Paths or patterns passed. `.` / `-A` / `--all` are common. */
  paths: string[]
  all: boolean
}

export type GitLogIntent = {
  kind: 'log'
  oneline: boolean
  /** -N limit if present. */
  limit?: number
}

export type GitPushIntent = {
  kind: 'push'
  /** Remote (usually "origin") and branch if they were positional. */
  remote?: string
  branch?: string
  force: boolean
}

export type GitIntent =
  | GitDiffIntent
  | GitCommitIntent
  | GitStatusIntent
  | GitAddIntent
  | GitLogIntent
  | GitPushIntent

/**
 * Detect a git intent from a command string. Returns null if:
 *   - the command isn't a straightforward git invocation
 *   - it's a git command we don't have a widget for
 *   - it's been composed with pipes/subshells/redirects that make
 *     the output unlikely to be clean git output
 *
 * We bail on pipes and redirects because our widgets parse raw git
 * output. `git diff | head -20` pipes into head which truncates
 * mid-hunk and produces unparseable output — better to let the
 * generic renderer show the raw string than parse nonsense.
 */
export function detectGitIntent(cmd: string | undefined | null): GitIntent | null {
  if (!cmd || typeof cmd !== 'string') return null
  const trimmed = cmd.trim()
  if (!trimmed) return null

  // Bail on multi-command constructions. We only handle single-command
  // git invocations. Detecting these via simple substring is imperfect
  // (matches inside quoted strings too) but the cost of a false bail
  // is "render generically" which is fine — we're never going to render
  // a pipe chain as a git widget anyway.
  //
  // NOTE: `git commit -m "$(cat <<'EOF' ... EOF)"` is the one important
  // exception. Those heredoc-commits are how agents build multi-line
  // commit bodies. We special-case them below by matching the commit
  // shape first, before falling through to the bail heuristics.
  if (/^git\s+commit\b/.test(trimmed)) {
    return parseCommit(trimmed)
  }
  if (/[|&;><]/.test(trimmed.replace(/"[^"]*"|'[^']*'/g, ''))) return null

  // Must start with `git ` — no `/usr/bin/git`, no `git -C …` for now.
  // Those are valid but rare and add edge cases we don't need for v1.
  const m = /^git\s+([a-z-]+)\b\s*(.*)$/i.exec(trimmed)
  if (!m) return null
  const sub = m[1]
  const rest = m[2] ?? ''
  const tokens = tokenize(rest)

  switch (sub) {
    case 'diff': return parseDiff(tokens)
    case 'status': return parseStatus(tokens)
    case 'add': return parseAdd(tokens)
    case 'log': return parseLog(tokens)
    case 'push': return parsePush(tokens)
    default: return null
  }
}

// ---------- per-subcommand parsers ----------

function parseDiff(tokens: string[]): GitDiffIntent {
  const flags: string[] = []
  const paths: string[] = []
  let sawDoubleDash = false
  let staged = false
  let nameOnly = false
  let stat = false
  for (const t of tokens) {
    if (t === '--') { sawDoubleDash = true; continue }
    if (sawDoubleDash) { paths.push(t); continue }
    if (t.startsWith('-')) {
      flags.push(t)
      if (t === '--staged' || t === '--cached') staged = true
      if (t === '--name-only' || t === '--name-status') nameOnly = true
      if (t === '--stat' || t === '--shortstat' || t === '--numstat') stat = true
    } else {
      // Positional token. Could be a revision (HEAD, HEAD~1, sha) or a
      // path. We keep both in `paths` for the widget's display — the
      // widget just shows them as context, it doesn't care which is
      // which.
      paths.push(t)
    }
  }
  return { kind: 'diff', flags, paths, staged, nameOnly, stat }
}

function parseStatus(tokens: string[]): GitStatusIntent {
  const porcelain = tokens.some(t => t === '--porcelain' || t === '-s' || t === '--short')
  return { kind: 'status', porcelain }
}

function parseAdd(tokens: string[]): GitAddIntent {
  const paths: string[] = []
  let all = false
  for (const t of tokens) {
    if (t === '-A' || t === '--all') { all = true; continue }
    if (t === '.') { all = true; paths.push(t); continue }
    if (t.startsWith('-')) continue
    paths.push(t)
  }
  return { kind: 'add', paths, all }
}

function parseLog(tokens: string[]): GitLogIntent {
  let oneline = false
  let limit: number | undefined
  for (const t of tokens) {
    if (t === '--oneline') { oneline = true; continue }
    // -N limit: standalone "-5", "-10", etc.
    const lim = /^-(\d+)$/.exec(t)
    if (lim) { limit = parseInt(lim[1], 10); continue }
  }
  return { kind: 'log', oneline, limit }
}

function parsePush(tokens: string[]): GitPushIntent {
  let force = false
  let remote: string | undefined
  let branch: string | undefined
  for (const t of tokens) {
    if (t === '-f' || t === '--force' || t === '--force-with-lease') { force = true; continue }
    if (t.startsWith('-')) continue
    if (!remote) { remote = t; continue }
    if (!branch) { branch = t; continue }
  }
  return { kind: 'push', remote, branch, force }
}

function parseCommit(cmd: string): GitCommitIntent | null {
  // Walk tokens; extract -m / --message payload if present and simple.
  // Heredoc form (`-m "$(cat <<'EOF' ... EOF)"`) is captured as whatever
  // the outer `$(...)` evaluates to — we don't try to peek into it;
  // the widget reconstructs the committed subject from `git commit`'s
  // own output instead, which contains `[branch sha] subject`.
  const amend = /\s(--amend)\b/.test(cmd)
  let message: string | undefined
  // Simple `-m "..."` or `-m '...'` only — we don't follow escapes.
  const simple = /\s-m\s+(?:"([^"]*)"|'([^']*)')/.exec(cmd)
  if (simple) message = simple[1] ?? simple[2]
  return { kind: 'commit', message, amend }
}

// ---------- tokenizer ----------

/**
 * Split a command argument string into shell-like tokens. Handles
 * double-quoted and single-quoted runs as single tokens, keeps the
 * quotes stripped. Doesn't try to be a full shell — good enough for
 * the commands we actually see, and if a weirder quoting pattern
 * appears the worst case is a failed detection and a fallback to
 * the generic renderer.
 */
function tokenize(s: string): string[] {
  const tokens: string[] = []
  let buf = ''
  let i = 0
  let quote: '"' | "'" | null = null
  while (i < s.length) {
    const c = s[i]
    if (quote) {
      if (c === quote) { quote = null; i++; continue }
      buf += c; i++; continue
    }
    if (c === '"' || c === "'") { quote = c; i++; continue }
    if (/\s/.test(c)) {
      if (buf) { tokens.push(buf); buf = '' }
      i++; continue
    }
    buf += c; i++
  }
  if (buf) tokens.push(buf)
  return tokens
}
