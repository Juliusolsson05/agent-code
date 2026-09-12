import { stat } from 'node:fs/promises'

import { getMainProvider, listMainProviders } from '@providers/registry.main.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'

// A transcript LOCATOR is the one string Agent Code publishes for "this
// agent's durable transcript": a JSONL path for Claude and Codex,
// `opencode://session/<id>` for OpenCode, whose sessions all live in one
// database with no file per session. The agent transcript MCP tools accept
// either, so a parent agent reads a child the same way whatever its provider.
//
// WHY the routing lives here and not at each consumer: Agent Management
// used to `stat()` whatever path it had, so an OpenCode locator (which both
// OpenCode runtimes already publish on every committed entry) failed the
// stat and was reported unavailable, and orchestration audits skipped every
// OpenCode child. Every consumer that turns a locator into facts now asks
// this module.

/**
 * The locator a provider's session has without a file on disk, or null for
 * file-backed providers (their path comes from the provider's resolver).
 */
export function providerSessionLocator(kind: AgentProviderKind, providerSessionId: string): string | null {
  return getMainProvider(kind).transcriptLocator?.(providerSessionId) ?? null
}

/**
 * When the transcript behind a locator last changed, or null when it cannot
 * be read (a rotated file, a deleted session, no OpenCode database). Null
 * means "do not publish this locator": a reader handed it would fail.
 */
export async function transcriptLastModifiedAt(locator: string): Promise<number | null> {
  for (const provider of listMainProviders()) {
    const id = provider.parseTranscriptLocator?.(locator)
    if (id) {
      // A provider-minted locator cannot be stat'ed. Its owner supplies durable
      // modification evidence (for OpenCode, session.time_updated) or refuses
      // publication; falling back to filesystem lookup would hide that policy.
      return await provider.transcriptLastModifiedAt?.(id) ?? null
    }
  }
  try {
    return (await stat(locator)).mtimeMs
  } catch {
    return null
  }
}
