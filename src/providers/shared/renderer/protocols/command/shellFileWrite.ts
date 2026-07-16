import type { CodeEditRenderModel } from '@providers/shared/renderer/protocols/code-edit/model'
import { lexShellLine, type ShellToken } from '@providers/shared/renderer/protocols/command/shellLex'

// Heredoc file-write extraction (PR #555 Phase 6 follow-up).
//
// WHY THIS EXISTS — live verdict from the product owner watching the Phase 6
// showcase (2026-07-17): `cat > path <<'EOF' … EOF` rendered as a squashed
// one-line command headline plus a conclusion line, while the CONTENT BEING
// WRITTEN — the entire point of the operation — was invisible. For the
// quoted-delimiter heredoc form the content is byte-exact recoverable from
// the command text itself (no shell expansion happens in a quoted-delimiter
// body), so the honest rendering is a real file-write card: the code-edit
// protocol, pure additions, streaming as the command streams.
//
// THE STRONG CONTRACT (same parse-fully-or-decline stance as the
// file-mutation formatter, and stricter):
//   - Only `cat` may be the writer. Any other command (`grep … > out`,
//     `sort … > out`) TRANSFORMS its stdin, so the heredoc body is NOT the
//     file content — showing it as such would be a false card.
//   - `cat` must have NO file operands (`cat file > x <<'EOF'` concatenates
//     the file with stdin — body ≠ content → decline).
//   - The heredoc delimiter must be QUOTED ('EOF' / "EOF"). An unquoted
//     delimiter body undergoes $-expansion, so the written bytes differ
//     from the visible text → decline to the plain command card.
//   - The first line may carry op-free prefix segments joined by `&&`/`;`
//     (the `mkdir -p dir && cat > dir/x <<'EOF'` idiom our own dev sessions
//     produce constantly) — but exactly ONE segment may contain redirect/
//     heredoc operators, and any `|`, `||`, `&` anywhere declines.
//   - After the terminator line, only whitespace may follow. A trailing
//     command (`EOF\nrm -rf …`) means the write is not the whole story —
//     decline rather than render a card that under-reports.
//
// STREAMING-FIRST: the extractor accepts a PARTIAL command text. The parse
// is trustworthy the moment the FIRST LINE has closed (its newline arrived)
// because everything below it is inert heredoc body; content lines then
// grow in place exactly like a streaming Write. `complete` flips when the
// terminator line lands.
//
// KNOWN EDGE (accepted, commented for future-you): while streaming, a
// prefix that parses as a heredoc write can be invalidated by later bytes
// (a trailing command after the terminator). The card then falls back to
// the command view. That flip is CORRECT — the write claim no longer stands
// alone — and the conservative alternative (never painting until the
// command closes) violates the streaming-first hard rule for exactly the
// biggest writes, where streaming matters most.

export type ShellHeredocWrite = {
  path: string
  append: boolean
  /** Real body lines (no trailing-newline artifact — each element is one
   *  written line). */
  contentLines: string[]
  /** Terminator line seen. False while the body is still streaming. */
  complete: boolean
}

export function extractShellHeredocWrite(commandText: string): ShellHeredocWrite | null {
  const nl = commandText.indexOf('\n')
  if (nl === -1) return null // first line not closed yet — nothing trustworthy
  const tokens = lexShellLine(commandText.slice(0, nl))
  if (!tokens) return null

  // Segment on `&&`/`;`; any pipe/or/background operator is unmodeled flow
  // control around a write → decline the whole line.
  const segments: ShellToken[][] = [[]]
  for (const t of tokens) {
    if (t.kind === 'op' && (t.text === '&&' || t.text === ';')) {
      segments.push([])
      continue
    }
    if (t.kind === 'op' && (t.text === '|' || t.text === '||' || t.text === '&')) return null
    segments[segments.length - 1].push(t)
  }

  let writeSeg: ShellToken[] | null = null
  for (const seg of segments) {
    if (seg.some(t => t.kind === 'op')) {
      if (writeSeg) return null // two op-bearing segments → undecidable
      writeSeg = seg
    }
  }
  if (!writeSeg) return null

  // Canonical shape check: word `cat`, exactly one `>`/`>>` + unquoted plain
  // target, exactly one `<<` + QUOTED delimiter, and nothing else.
  let path: string | null = null
  let append = false
  let delimiter: string | null = null
  let sawCat = false
  for (let i = 0; i < writeSeg.length; i++) {
    const t = writeSeg[i]
    if (t.kind === 'op') {
      const next = writeSeg[i + 1]
      if (!next || next.kind !== 'word') return null
      if (t.text === '>' || t.text === '>>') {
        if (path !== null || next.quoted) return null
        path = next.text
        append = t.text === '>>'
      } else if (t.text === '<<') {
        if (delimiter !== null || !next.quoted) return null // unquoted → expansion → decline
        delimiter = next.text
      } else {
        return null
      }
      i += 1
      continue
    }
    if (!sawCat) {
      if (t.text !== 'cat' || t.quoted) return null
      sawCat = true
      continue
    }
    return null // extra operand — `cat file > x <<'EOF'` concatenates → decline
  }
  if (!sawCat || path === null || delimiter === null) return null

  const bodyLines = commandText.slice(nl + 1).split('\n')
  const end = bodyLines.indexOf(delimiter)
  if (end === -1) {
    return { path, append, contentLines: bodyLines, complete: false }
  }
  for (let i = end + 1; i < bodyLines.length; i++) {
    if (/\S/.test(bodyLines[i])) return null // trailing command after terminator
  }
  return { path, append, contentLines: bodyLines.slice(0, end), complete: true }
}

/** ShellHeredocWrite → code-edit model (provider-neutral: both the Claude
 *  Bash adapter and the Codex exec adapter feed their extracted command
 *  text through here). Pure additions, honest Write semantics — a heredoc
 *  overwrite has no visible before-state, an append genuinely only adds. */
export function shellHeredocWriteModel(
  write: ShellHeredocWrite,
  opts: { streaming: boolean; label: string },
): CodeEditRenderModel {
  const lines = write.contentLines.map(text => ({ kind: '+' as const, text }))
  return {
    label: opts.label,
    files: [
      {
        path: write.path,
        verb: write.append ? 'Appending' : 'Writing',
        lines,
        additions: lines.length,
        deletions: 0,
        streaming: opts.streaming,
      },
    ],
    status: opts.streaming ? 'streaming' : 'success',
    partial: opts.streaming || !write.complete,
  }
}
