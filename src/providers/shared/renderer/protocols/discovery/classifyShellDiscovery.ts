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

    // WHY only pipe and semicolon: both merely connect already-proven
    // read-only commands. Redirection writes, background work outlives the
    // visible row, heredocs hide a second language, and &&/|| make execution
    // conditional. Those shapes remain honest generic commands until their
    // complete semantics are independently evidenced.
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
  // Quoted/path-qualified program names are valid shell, but normalizing them
  // safely requires command resolution. Declining costs only enrichment.
  if (!command || command.quoted || command.text.includes('/')) return null
  const kind = SIMPLE_COMMANDS.get(command.text)
  if (!kind) return null

  const args = words.slice(1).map(word => word.text)
  if (
    command.text === 'rg' &&
    args.some(arg => arg === '--pre' || arg.startsWith('--pre=') || arg === '--pre-glob' || arg.startsWith('--pre-glob='))
  ) {
    // ripgrep's --pre executes an arbitrary program for every searched file.
    // A command named `rg` is therefore not sufficient proof of read-only
    // behavior; the option boundary is part of the semantic contract.
    return null
  }
  if (
    command.text === 'sort' &&
    args.some(arg => arg === '-o' || arg === '--output' || arg.startsWith('--output='))
  ) {
    return null
  }
  return kind
}

/**
 * Classify one complete shell expression or decline the whole expression.
 *
 * This is deliberately an allowlist of commands present in the recorded
 * development corpus. It is not a general claim that every invocation of a
 * familiar Unix utility is harmless. New commands/options enter only with a
 * real fixture and an explicit safety review.
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
