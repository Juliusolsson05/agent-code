import type { CommandFormatter } from '@providers/shared/renderer/protocols/command/formatters/types'
import { lexShellLine, type ShellToken } from '@providers/shared/renderer/protocols/command/shellLex'

// File-mutation-disguised-as-command formatter (PR #555 Phase 6).
//
// WHY THIS FAMILY EXISTS — captured live from our own development session
// (2026-07-16): while building this very feature, the implementing agent
// wrote/edited files through command shapes that never render as
// Write/Edit cards: heredoc `cat > path <<EOF`, heredoc APPENDS,
// `python3 - <<EOF` inline-script writers, `sed -i` in-place edits,
// `echo … > path`, subshell compositions `{ …; } > path`, and cp/rm
// pseudo-moves. The full fix (routing into the code-edit protocol with a
// real diff) needs before/after state the wire doesn't carry; what CAN be
// honest today is a conclusion line naming the mutation and target.
//
// WHY A TOKENIZER, NOT REGEXES (product-owner correction, same day): regex
// scanning over shell text is structurally unable to distinguish operator
// `>` from quoted content (`echo "a > b"`), so it eventually produces a
// FALSE "writes b" — and a wrong claim on a card is strictly worse than no
// claim. The contract here is PARSE-FULLY-OR-DECLINE:
//   - a small real lexer walks the first line honoring '…', "…" and \\
//     escapes, so quoted text can never look like an operator;
//   - ANY construct the lexer does not model — $(…), backticks, process
//     substitution, fd redirection (2>&1, >&2), subshell parens — aborts
//     the ENTIRE conclusion. Unknown shell is undecidable shell; we
//     decline rather than approximate.
//   - /dev/null|stdout|stderr targets are sinks, not file mutations.
// This inverts the failure mode: gaps cost us a missing enrichment line
// (raw output is always there anyway), never a false claim.

const OUTPUT_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr'])
const INLINE_INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl'])

export const fileMutationFormatter: CommandFormatter = {
  id: 'file-mutation',
  conclude({ command }) {
    // First line only: heredoc bodies below it are CONTENT, and content is
    // where false matches live.
    const tokens = lexShellLine(command.split('\n')[0])
    if (!tokens) return null // unmodeled shell → decline, never approximate

    // Inline interpreter fed by stdin/heredoc: the real paths live inside
    // the script body, which we refuse to parse — say what we KNOW.
    const first = tokens[0]
    if (
      first?.kind === 'word' &&
      INLINE_INTERPRETERS.has(first.text) &&
      tokens.some(t => (t.kind === 'op' && t.text === '<<') || (t.kind === 'word' && t.text === '-'))
    ) {
      return `runs an inline ${first.text} script (may write files — see body)`
    }

    // sed -i: in-place edit; target = the last WORD (sed's file operand).
    const words = tokens.filter((t): t is ShellToken & { kind: 'word' } => t.kind === 'word')
    if (words[0]?.text === 'sed' && words.some(w => !w.quoted && (w.text === '-i' || w.text.startsWith('-i')))) {
      const target = words[words.length - 1]
      if (target && target.text !== 'sed' && !target.text.startsWith('-') && !target.quoted) {
        return `edits ${target.text} in place (sed -i)`
      }
      return null
    }

    // Unquoted > / >> with a plain word target = a real file mutation.
    const targets: { path: string; append: boolean }[] = []
    let heredoc = false
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.kind !== 'op') continue
      if (t.text === '<<') heredoc = true
      if (t.text === '>' || t.text === '>>') {
        const next = tokens[i + 1]
        if (!next || next.kind !== 'word' || next.quoted) return null // odd target → decline whole line
        if (OUTPUT_SINKS.has(next.text)) continue
        targets.push({ path: next.text, append: t.text === '>>' })
      }
    }
    if (targets.length === 0) return null
    const [head, ...rest] = targets
    const more = rest.length > 0 ? ` (+${rest.length} more target${rest.length === 1 ? '' : 's'})` : ''
    return `${head.append ? 'appends to' : 'writes'} ${head.path}${heredoc ? ' (heredoc)' : ''}${more}`
  },
}
