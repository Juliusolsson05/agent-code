// Shell line lexer — the strong-contract primitive under BOTH the
// file-mutation formatter and the heredoc-write extractor (PR #555 Phase 6;
// moved out of formatters/file-mutation when the second consumer appeared).
//
// WHY A TOKENIZER, NOT REGEXES (product-owner correction, 2026-07-16): regex
// scanning over shell text is structurally unable to distinguish operator
// `>` from quoted content (`echo "a > b"`), so it eventually produces a
// FALSE claim — and a wrong claim on a card is strictly worse than no claim.
// The contract is PARSE-FULLY-OR-DECLINE:
//   - the lexer walks ONE line honoring '…', "…" and \ escapes, so quoted
//     text can never look like an operator;
//   - ANY construct it does not model — $(…), backticks, process
//     substitution, fd redirection (2>&1, >&2), subshell parens — aborts
//     the ENTIRE parse (returns null). Unknown shell is undecidable shell;
//     consumers decline rather than approximate.
// This inverts the failure mode: gaps cost a missing enrichment (raw text
// is always still rendered), never a false claim.

export type ShellToken =
  | { kind: 'word'; text: string; quoted: boolean }
  | { kind: 'op'; text: '>' | '>>' | '<<' | '|' | ';' | '&&' | '||' | '&' }

/** Lex ONE line of shell. Returns null the moment an unmodeled construct
 *  appears — the caller's decline, by contract. */
export function lexShellLine(line: string): ShellToken[] | null {
  const tokens: ShellToken[] = []
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
