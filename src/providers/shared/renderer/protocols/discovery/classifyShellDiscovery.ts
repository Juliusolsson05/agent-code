import {
  lexShellLine,
  type ShellToken,
} from '@providers/shared/renderer/protocols/command/shellLex'
import type { DiscoveryKind } from '@providers/shared/renderer/protocols/discovery/model'

type SegmentKind = DiscoveryKind | 'filter'
type WordToken = Extract<ShellToken, { kind: 'word' }>

const SIMPLE_COMMANDS = new Map<string, SegmentKind>([
  ['rg', 'search'],
  ['grep', 'search'],
  ['cat', 'read'],
  ['head', 'filter'],
  ['tail', 'filter'],
  ['wc', 'filter'],
  ['sort', 'filter'],
  ['ls', 'list'],
  ['du', 'list'],
])

function splitSegments(tokens: readonly ShellToken[]): WordToken[][] | null {
  const segments: WordToken[][] = []
  let words: WordToken[] = []
  for (const token of tokens) {
    if (token.kind === 'word') {
      words.push(token)
      continue
    }

    // WHY only pipe and semicolon: both combine already-admitted discovery
    // intent without contradicting the headline. Redirection writes,
    // background work outlives the visible row, heredocs hide a second
    // language, and &&/|| make execution conditional. Those shapes remain
    // honest generic commands until their presentation semantics are
    // independently evidenced.
    if (token.text !== '|' && token.text !== ';') return null
    if (words.length === 0) return null
    segments.push(words)
    words = []
  }
  if (words.length === 0) return null
  segments.push(words)
  return segments
}

function segmentKind(words: readonly WordToken[]): SegmentKind | null {
  const command = words[0]
  // Quoted/path-qualified program names are valid shell, but neither form is
  // present in the recorded intent vocabulary. Declining costs only
  // enrichment and avoids implying that a different executable spelling was
  // reviewed merely because its basename looks familiar.
  if (!command || command.quoted || command.text.includes('/')) return null
  const kind = SIMPLE_COMMANDS.get(command.text)
  if (!kind) return null

  const args = words.slice(1).map(word => word.text)
  const endOfOptions = args.indexOf('--')
  const options = endOfOptions >= 0 ? args.slice(0, endOfOptions) : args
  if (
    command.text === 'rg' &&
    options.some(arg =>
      arg === '--pre' ||
      arg.startsWith('--pre=') ||
      arg === '--pre-glob' ||
      arg.startsWith('--pre-glob=') ||
      arg === '--hostname-bin' ||
      arg.startsWith('--hostname-bin='),
    )
  ) {
    // ripgrep can execute arbitrary helper programs through --pre and
    // --hostname-bin. Those visible options directly contradict a simple
    // Search/List headline even though this renderer is not an authorization
    // boundary and cannot resolve the eventual executable through PATH.
    return null
  }
  if (command.text === 'sort' && options.some(arg => arg.startsWith('-'))) {
    // The recorded corpus proves only the bare `sort` filter used by the rg
    // carrier. sort's option grammar includes attached output forms (-oFILE),
    // long-option abbreviations, and helper execution (--compress-program).
    // Admit new options from evidence instead of maintaining a denylist that
    // becomes unsafe whenever the utility adds another side-effecting flag.
    return null
  }
  if (command.text === 'rg' && options.includes('--files')) return 'list'
  return kind
}

/**
 * Classify one complete shell expression or decline the whole expression.
 *
 * This is deliberately a textual-intent classifier for presentation, not an
 * execution authorization boundary. A transcript does not carry enough
 * evidence to resolve PATH, shell functions, aliases, or the executable that
 * ultimately ran, so a command.search receipt must never be treated as proof
 * that execution was side-effect free. Within the visible syntax, commands
 * and options enter only from real evidence; explicit mutation or helper
 * execution makes the whole expression decline.
 */
export function classifyShellDiscovery(command: string): DiscoveryKind | null {
  if (!command.trim() || /[\r\n]/.test(command)) return null
  const tokens = lexShellLine(command)
  if (!tokens) return null
  const segments = splitSegments(tokens)
  if (!segments) return null

  const kinds: SegmentKind[] = []
  for (const segment of segments) {
    const kind = segmentKind(segment)
    if (!kind) return null
    kinds.push(kind)
  }

  // Search is the user intent even when sort/head only shape its result.
  // List similarly owns `ls | head`; a filter-only expression reads data but
  // does not establish a more specific search/list intent.
  if (kinds.includes('search')) return 'search'
  if (kinds.includes('list')) return 'list'
  return 'read'
}
