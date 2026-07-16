import type { CommandFormatter } from '@providers/shared/renderer/protocols/command/formatters/types'

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

type Token =
  | { kind: 'word'; text: string; quoted: boolean }
  | { kind: 'op'; text: '>' | '>>' | '<<' | '|' | ';' | '&&' | '||' | '&' }

/** Lex ONE line of shell. Returns null the moment an unmodeled construct
 *  appears — the caller's decline, by contract. */
function lexShellLine(line: string): Token[] | null {
  const tokens: Token[] = []
  let word = ''
  let wordQuoted = false
  const flush = (): void => {
    if (word !== '') tokens.push({ kind: 'word', text: word, quoted: wordQuoted })
    word = ''
    wordQuoted = false
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'" || c === '"') {
      const quote = c
      wordQuoted = true
      i += 1
      while (i < line.length) {
        if (quote === '"' && line[i] === '\\') {
          // Inside double quotes, \$ \" \\ escape; $ still expands — and
          // expansion is exactly what we don't model.
          if (line[i + 1] === '$' || line[i + 1] === '"' || line[i + 1] === '\\') {
            word += line[i + 1]
            i += 2
            continue
          }
        }
        if (quote === '"' && (line[i] === '$' || line[i] === '`')) return null // expansion → decline
        if (line[i] === quote) break
        word += line[i]
        i += 1
      }
      if (i >= line.length) return null // unterminated quote → decline
      continue
    }
    if (c === '\\') {
      if (line[i + 1] === undefined) return null // trailing escape → decline
      word += line[i + 1]
      i += 1
      continue
    }
    if (c === '$' || c === '`' || c === '(' || c === ')') return null // substitution/subshell → decline
    if (c === ' ' || c === '\t') {
      flush()
      continue
    }
    if (c === '>' || c === '<') {
      // fd-prefixed (2>) or fd-target (>&1) redirection: not modeled.
      if (/[0-9]/.test(word) && word.length <= 2) return null
      flush()
      const double = line[i + 1] === c
      if (double) i += 1
      if (line[i + 1] === '&') return null // >&2 style → decline
      if (c === '<' && !double) return null // plain stdin redirect: unmodeled
      tokens.push({ kind: 'op', text: c === '<' ? '<<' : double ? '>>' : '>' })
      continue
    }
    if (c === '|' || c === ';' || c === '&') {
      flush()
      const double = line[i + 1] === c
      if (double) i += 1
      tokens.push({ kind: 'op', text: (double ? ((c + c) as '&&' | '||') : (c as '|' | ';' | '&')) })
      continue
    }
    word += c
  }
  flush()
  return tokens
}

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
    const words = tokens.filter((t): t is Token & { kind: 'word' } => t.kind === 'word')
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
