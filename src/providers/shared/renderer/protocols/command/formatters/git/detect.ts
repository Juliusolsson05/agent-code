// Detect Git intent from a provider-normalized command string.
//
// Provider adapters hand the command protocol one command string. This
// formatter decides:
//   - Is the shell program solely one or more Git invocations?
//   - Which familiar subcommand can use a rich parser?
//   - Which broader or compound workflow needs the generic Git workflow card?
//
// Heuristic, not a shell parser. We care about the common shapes
// agents actually emit ("git diff", "git diff --staged", "git
// commit -m ...", "git add .", "git status", "git log --oneline
// -5"). Anything exotic (pipes, subshells, aliases, `git -C <dir>`
// invocations) returns null so the feed falls back to the generic command
// renderer. Unknown but syntactically plain Git subcommands retain a generic
// Git workflow card with exact raw output. A missed
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

export type GitWorkflowStep = {
  command: string
  verb: string
  args: string
}

export type GitWorkflowIntent = {
  kind: 'workflow'
  steps: GitWorkflowStep[]
  operators: Array<'&&' | ';' | 'newline'>
  /** The mutation or query that best names the workflow. This is display
   * vocabulary only; every step remains visible and no output is discarded. */
  primaryVerb: string
}

export type GitIntent =
  | GitDiffIntent
  | GitCommitIntent
  | GitStatusIntent
  | GitAddIntent
  | GitLogIntent
  | GitPushIntent
  | GitWorkflowIntent

/**
 * Detect a git intent from a command string. Returns null if:
 *   - the command isn't a straightforward git invocation
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

  // WHY command substitution is an ownership boundary, even when the text
  // still starts with `git`: the shell replaces `$()` / backticks before Git
  // sees argv. A detector that reads `git diff $(printf -- --stat)` as a
  // normal diff predicts the wrong output grammar and then lets the Git card
  // absorb evidence it cannot parse. Literal substitution-looking text in
  // single quotes is inert and remains admissible. The one executable form we
  // intentionally understand is the agent's canonical quoted-heredoc commit
  // message; its quoted delimiter makes the body literal, and Git's own
  // success header is the source of truth for the resulting subject.
  if (hasDisallowedCommandSubstitution(trimmed)) return null

  // Chained commands (`git status && git add -A && git commit -m ...`)
  // are the workflow agents actually use — fetch state, stage, commit
  // in one shot. Every segment MUST independently be a supported Git
  // operation before the combined command can enter this formatter.
  //
  // WHY an unsupported segment rejects the whole chain instead of being
  // ignored: the provider gives us one combined stdout/stderr result. If
  // `git status && npm test` were admitted as `status`, the status card would
  // absorb the result row and silently discard the test output. A false
  // negative merely uses the total generic command/result UI; a false positive
  // loses evidence. This conservative asymmetry is the formatter boundary.
  //
  // Split before the commit fast-path below. Otherwise a command beginning
  // `git commit ... && <anything>` matches the leading commit regex and never
  // exposes the mixed tail for validation. `splitTopLevel` ignores separators
  // inside quoted runs, so the canonical `"$(cat <<'EOF' ... EOF)"` commit
  // message remains one segment.
  //
  // WHY a chain is a workflow instead of one "winning" intent: collapsing
  // `diff guard && reset && status` into diff made the actual mutation vanish;
  // collapsing `add && diff --cached --check` into diff hid staging and its
  // verification. One shell execution remains one card, but every Git step is
  // retained and the primary mutation names the card.
  const split = splitTopLevel(trimmed)
  if (!split) return null
  const { segments, operators } = split
  if (segments.length > 1) {
    const steps: GitWorkflowStep[] = []
    for (const seg of segments) {
      const sub = detectGitIntent(seg.trim())
      if (!sub) return null
      if (sub.kind === 'workflow') steps.push(...sub.steps)
      else {
        const step = parsePlainGitStep(seg.trim())
        if (!step) return null
        steps.push(step)
      }
    }
    return {
      kind: 'workflow',
      steps,
      operators,
      primaryVerb: primaryWorkflowVerb(steps),
    }
  }

  // Heredoc-commits (`git commit -m "$(cat <<'EOF' ... EOF)"`) are the
  // canonical multi-line commit shape agents emit. The top-level scan above
  // ignores the heredoc's `<<` because it is inside the outer double-quoted
  // message, while still rejecting a real `git commit ... > file` redirect.
  // WHY the guard must happen before this fast-path: commit accepts a much
  // looser multi-line message shape than every other subcommand. Letting the
  // leading regex run first made `git commit ... | tool`, background jobs,
  // and newline scripts absorb output that did not belong solely to Git.
  if (/^git\s+commit\b/.test(trimmed)) {
    return parseCommit(trimmed)
  }

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
    default: {
      const step = parsePlainGitStep(trimmed)
      return step
        ? { kind: 'workflow', steps: [step], operators: [], primaryVerb: step.verb }
        : null
    }
  }
}

function parsePlainGitStep(command: string): GitWorkflowStep | null {
  const match = /^git\s+([a-z][a-z-]*)\b\s*([\s\S]*)$/i.exec(command)
  if (!match) return null
  return { command, verb: match[1].toLowerCase(), args: match[2] ?? '' }
}

function primaryWorkflowVerb(steps: readonly GitWorkflowStep[]): string {
  // Mutations outrank observations so `diff guard && reset && status` names
  // the state change, while every guard/verification remains visible below.
  const priority = [
    'commit', 'push', 'merge', 'rebase', 'reset', 'stash', 'switch',
    'checkout', 'restore', 'branch', 'tag', 'add', 'pull', 'fetch',
    'worktree', 'submodule', 'status', 'diff', 'log', 'show', 'rev-parse',
  ]
  for (const verb of priority) {
    if (steps.some(step => step.verb === verb)) return verb
  }
  return steps[0]?.verb ?? 'workflow'
}

/** Return the index immediately after a canonical `$(cat <<'EOF' … EOF)`
 * message, or null when the substitution is executable open-world shell.
 *
 * WHY this is deliberately narrower than a shell parser: admission has an
 * asymmetric cost. Declining an unusual but valid Git command preserves every
 * byte in the generic row; accepting a substitution whose output changes Git
 * flags can hide or misinterpret the correlated result. */
function canonicalHeredocCommitEnd(command: string, substitutionAt: number): number | null {
  if (command[substitutionAt - 1] !== '"') return null

  const prefix = command.slice(0, substitutionAt - 1)
  // The opening quote must be the entire -m payload, not a substitution
  // embedded in otherwise dynamic message text. Restrict the check to the
  // current top-level segment so the supported `git add && git commit ...`
  // chain remains admissible.
  if (!/(?:^|&&|;)\s*git\s+commit\b[^;&\r\n]*\s(?:-m|--message)\s*$/.test(prefix)) {
    return null
  }

  const tail = command.slice(substitutionAt + 2)
  const header = /^\s*cat\s+<<(-?)\s*'([A-Za-z_][A-Za-z0-9_]*)'\r?\n/.exec(tail)
  if (!header) return null

  const stripTabs = header[1] === '-'
  const delimiter = header[2]
  const escapedDelimiter = delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const terminator = new RegExp(
    `(?:^|\\r?\\n)${stripTabs ? '\\t*' : ''}${escapedDelimiter}\\r?\\n\\)"`,
  )
  const bodyAndTerminator = tail.slice(header[0].length)
  const match = terminator.exec(bodyAndTerminator)
  if (!match) return null

  return substitutionAt + 2 + header[0].length + match.index + match[0].length
}

function hasDisallowedCommandSubstitution(command: string): boolean {
  let quote: '"' | "'" | null = null
  let i = 0
  while (i < command.length) {
    const char = command[i]

    // Backslash suppresses expansion of the following glyph outside single
    // quotes and inside double quotes. Skipping the pair keeps escaped `\$(`
    // and escaped backticks as literal argv rather than false rejections.
    if (quote !== "'" && char === '\\' && command[i + 1] !== undefined) {
      i += 2
      continue
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'"
      i += 1
      continue
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"'
      i += 1
      continue
    }
    if (quote !== "'" && char === '`') return true
    if (quote !== "'" && char === '$' && command[i + 1] === '(') {
      const canonicalEnd = quote === '"' ? canonicalHeredocCommitEnd(command, i) : null
      if (canonicalEnd === null) return true
      // The helper consumed the message's closing double quote too. Resetting
      // quote state prevents the rest of a safe Git chain from being mistaken
      // for inert message text.
      quote = null
      i = canonicalEnd
      continue
    }
    i += 1
  }
  return false
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
 * Split a command string into segments at top-level `&&`, `;`, or newline
 * separators, ignoring anything inside double- or single-quoted
 * runs. The agent's typical heredoc-commit pattern wraps the
 * commit body inside `"$(cat <<'EOF' ... EOF)"` — the outer `"..."`
 * keeps the heredoc body invisible to this splitter, so we can
 * still segment a chain like:
 *
 *   git status && git add -A && git commit -m "$(cat <<'EOF'
 *   subject
 *   EOF
 *   )"
 *
 * into three pieces without slicing the heredoc.
 */
function splitTopLevel(s: string): {
  segments: string[]
  operators: Array<'&&' | ';' | 'newline'>
} | null {
  const out: string[] = []
  const operators: Array<'&&' | ';' | 'newline'> = []
  let buf = ''
  let i = 0
  let quote: '"' | "'" | null = null
  while (i < s.length) {
    const c = s[i]
    if (quote) {
      // WHY escaped quote handling matters here: a commit message such as
      // `-m "say \"ship\"" && npm test` must expose the mixed tail. Ending
      // the quote at the escaped glyph would turn shell syntax back into
      // apparent message text and recreate the fast-path false positive.
      if (quote === '"' && c === '\\' && s[i + 1] !== undefined) {
        buf += c + s[i + 1]
        i += 2
        continue
      }
      if (c === quote) quote = null
      buf += c
      i++
      continue
    }
    if (c === '"' || c === "'") { quote = c; buf += c; i++; continue }
    if (c === '\\') {
      if (s[i + 1] === undefined) return null
      buf += c + s[i + 1]
      i += 2
      continue
    }
    // `&&` separator — two chars, only at top level.
    if (c === '&' && s[i + 1] === '&') {
      out.push(buf)
      operators.push('&&')
      buf = ''
      i += 2
      continue
    }
    if (c === ';') {
      out.push(buf)
      operators.push(';')
      buf = ''
      i++
      continue
    }
    if (c === '\n' || c === '\r') {
      out.push(buf)
      operators.push('newline')
      buf = ''
      if (c === '\r' && s[i + 1] === '\n') i++
      i++
      continue
    }
    // WHY pipes, OR-lists, and background jobs are not ordinary segments:
    // even when both sides happen to be Git, their stdout/stderr may be
    // transformed, conditional, or interleaved. Splitting a lone `&` as if
    // it were `;` was especially tempting, but that would turn concurrent
    // output into a sequential card. The safe model is to recognize these
    // top-level operators and decline the rich formatter altogether.
    if (c === '|' || c === '&') return null
    // Any top-level redirect changes or removes Git's parseable result.
    // Redirect-looking text inside a quoted commit message never reaches
    // this branch, which is why this scan replaces the old quote-stripping
    // regex and can safely run before the commit exception.
    if (c === '>' || c === '<') return null
    buf += c
    i++
  }
  if (quote) return null
  // Preserve an empty trailing/leading segment once a separator was seen.
  // `git status &&` and `; git status` are incomplete shell programs, not a
  // trustworthy single Git operation. The caller recursively rejects the
  // empty segment instead of accidentally reparsing the unsplit original.
  if (buf || out.length > 0) out.push(buf)
  return { segments: out, operators }
}

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
