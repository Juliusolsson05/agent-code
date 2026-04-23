// Provider-dispatching wrapper for extractAssistantInProgress.
//
// Both Claude and Codex have their own screen-scraping parser, but the
// callers in the renderer (TileLeaf baseline capture, Feed streaming
// card, workspaceStore baseline) don't want to know which provider's
// parser to call — they just want "give me the assistant's in-progress
// text from this screen snapshot." This module routes based on a
// `provider` argument so the callers stay provider-agnostic.

// Direct file imports — the parser files are pure TypeScript, safe for
// the renderer bundle. The headless package entry points pull in Node
// deps so we can't import through them in browser context.
import { extractAssistantInProgress as claudeExtract } from '@shared/parsers/claudeScreen'
import { extractCodexAssistantInProgress as codexExtract } from '@shared/parsers/codexScreen'

export type AgentProvider = 'claude' | 'codex'

/**
 * Extract the most-recent assistant text block from a screen snapshot,
 * dispatching to the right provider's parser.
 *
 * Falls back to claude when provider is undefined (backwards compat
 * for any call site that hasn't been updated yet).
 */
export function extractAssistantInProgress(
  screen: string,
  provider: AgentProvider = 'claude',
): string {
  if (provider === 'codex') return codexExtract(screen)
  return claudeExtract(screen)
}
