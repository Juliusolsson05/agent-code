// Provider-dispatching wrapper for extractAssistantInProgress.
//
// Both Claude and Codex have their own screen-scraping parser, but the
// callers in the renderer (TileLeaf baseline capture, Feed streaming
// card, workspaceStore baseline) don't want to know which provider's
// parser to call — they just want "give me the assistant's in-progress
// text from this screen snapshot." This module routes based on a
// `provider` argument so the callers stay provider-agnostic.

import { extractAssistantInProgress as claudeExtract } from '../../core/parsers/claude/streamingScreen.js'
import { extractCodexAssistantInProgress as codexExtract } from '../../core/parsers/codex/streamingScreen.js'

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
