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
import { extractAssistantInProgress as claudeExtract } from '@shared/parsers/claudeScreen.js'
import { extractCodexAssistantInProgress as codexExtract } from '@shared/parsers/codexScreen.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'

// Alias of the single provider source of truth (#394 phase 1). The
// dispatch below is still hand-written — moving the parser onto the
// provider registry is phase-2 work — but it is now an exhaustive
// switch, so registering a third provider makes THIS site a compile
// error instead of silently routing to the Claude parser.
export type AgentProvider = AgentProviderKind

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
  // Exhaustive on purpose — no default arm. TypeScript proves every
  // AgentProviderKind is handled; a new provider fails compilation
  // here rather than inheriting Claude's parser at runtime.
  switch (provider) {
    case 'codex':
      return codexExtract(screen)
    case 'claude':
      return claudeExtract(screen)
    case 'opencode':
      // Structured OpenCode streams semantic SSE text rather than a screen.
      // OpenCode Terminal does have a PTY, but is forced to the raw surface:
      // pretending Claude/Codex escape-sequence heuristics understand its TUI
      // would produce plausible-but-wrong Reader text. Add a dedicated parser
      // here only if the terminal runtime later supports rendered/Reader views.
      return ''
  }
}
