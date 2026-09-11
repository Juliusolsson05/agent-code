import { stat } from 'node:fs/promises'

import { opencodeTranscriptFile, parseOpencodeTranscriptFile } from 'opencode-terminal-headless'

import { readOpencodeSessionInfo } from '@providers/opencode/runtime/opencodeDatabase.js'
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
  switch (kind) {
    case 'opencode':
      return opencodeTranscriptFile(providerSessionId)
    case 'claude':
    case 'codex':
      return null
  }
}

/**
 * When the transcript behind a locator last changed, or null when it cannot
 * be read (a rotated file, a deleted session, no OpenCode database). Null
 * means "do not publish this locator": a reader handed it would fail.
 */
export async function transcriptLastModifiedAt(locator: string): Promise<number | null> {
  const opencodeSessionID = parseOpencodeTranscriptFile(locator)
  if (opencodeSessionID) {
    // The session row's time_updated stands in for a JSONL file's mtime.
    // OpenCode rewrites that row when a prompt is submitted and again as each
    // step's summary lands, so it tracks the conversation, not just
    // renames: in every recorded session under opencode-terminal-headless's
    // testing/fixtures/durable it sits within seconds of the newest part
    // write.
    return (await readOpencodeSessionInfo(opencodeSessionID))?.timeUpdated ?? null
  }
  try {
    return (await stat(locator)).mtimeMs
  } catch {
    return null
  }
}
