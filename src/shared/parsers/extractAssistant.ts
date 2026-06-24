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
 * Provider is intentionally required. The old default silently treated every
 * unknown/omitted provider as Claude, which is exactly the kind of binary
 * fallback that makes a third provider fail in different ways per surface.
 * Callers already know the session kind at the point they have a screen
 * snapshot, so making that knowledge explicit is the safer contract.
 */
export function extractAssistantInProgress(
  screen: string,
  provider: AgentProvider,
): string {
  if (provider === 'codex') return codexExtract(screen)
  return claudeExtract(screen)
}
