import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

/**
 * The `usage` built-in domain (#1339): one read-only tool that returns the
 * same sanitized provider-quota snapshot as the Usage screen and root
 * management's `ac_usage_read`.
 *
 * WHY a separate domain instead of telling agents to use root management:
 * root management hands an agent the whole application's control catalog and
 * is confirmation-gated per agent, so orchestrating agents (and the review
 * pipelines that spawn children across providers) could not see quota at all
 * and found Grok at 100% only by accident. Reading numbers the user's own
 * Usage screen already shows needs none of that authority.
 */
export type UsageToolDependencies = {
  /** The sanitized snapshot (main's readUsageSnapshotForTools). Injected
   *  because src/mcp must not import main; missing means composition did not
   *  wire it, and the tool says so instead of inventing numbers. */
  readUsageSnapshot?: () => Promise<unknown>
}

export const USAGE_INSTRUCTIONS = [
  'Provider usage (usage_read): before spawning work on a provider, read its quota.',
  'Each provider row carries its window, percent used, severity and reset time; a provider error is reported as an error, never as zero usage.',
  'Results are cached for about 30 seconds, so reading repeatedly does not refresh faster.',
].join(' ')

export function registerUsageTools(server: McpServer, dependencies: UsageToolDependencies): void {
  server.registerTool('usage_read', {
    title: 'Read provider usage and quota',
    description: 'Read the sanitized Claude, Codex, Grok and OpenCode (z.ai) quota snapshot the Usage screen shows: per provider, each window\'s percent used, severity, reset time and fetch time, plus per-provider errors. Never returns credentials and never treats a provider error as zero usage. Served from a ~30 s cache.',
    // WHY no `force` input (unlike ac_usage_read): a fleet of agents polling
    // with force would bypass the cache and hit every provider's quota
    // endpoint once per call. The cache's 30 s is fresher than any spawn
    // decision needs.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => {
    if (!dependencies.readUsageSnapshot) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, message: 'Usage is unavailable.' }) }], isError: true }
    }
    try {
      const snapshot = await dependencies.readUsageSnapshot()
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, snapshot }) }] }
    } catch {
      // Curated: a fetch failure's text can carry provider URLs (q22). The
      // snapshot itself already reports per-provider errors; this is only the
      // whole read failing.
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, message: 'Usage could not be read.' }) }], isError: true }
    }
  })
}
