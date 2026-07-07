import type {
  UsageProviderKind,
  UsageProviderSnapshot,
  UsageSnapshot,
  UsageSnapshotRequest,
} from '@shared/types/usage.js'

import { readClaudeUsage } from '@main/usage/claudeUsage.js'
import { readCodexUsage } from '@main/usage/codexUsage.js'
import { sanitizeUsageError } from '@main/usage/normalize.js'

const USAGE_CACHE_TTL_MS = 30_000

let cachedSnapshot: UsageSnapshot | null = null

async function readProvider(
  provider: UsageProviderKind,
  sourceLabel: string,
  loader: () => Promise<UsageProviderSnapshot>,
): Promise<UsageProviderSnapshot> {
  try {
    return await loader()
  } catch (err) {
    return {
      provider,
      status: 'error',
      sourceLabel,
      message: sanitizeUsageError(err, `Could not load ${provider} usage.`),
    }
  }
}

export async function getUsageSnapshot(request: UsageSnapshotRequest = {}): Promise<UsageSnapshot> {
  const now = Date.now()
  if (
    !request.force &&
    cachedSnapshot &&
    now - Date.parse(cachedSnapshot.fetchedAt) < USAGE_CACHE_TTL_MS
  ) {
    return {
      ...cachedSnapshot,
      cache: { hit: true, ttlMs: USAGE_CACHE_TTL_MS },
    }
  }

  // WHY the providers are fetched independently:
  //
  // Claude and Codex have different auth stores, network hosts, and outage
  // modes. A stale Codex token should not hide a perfectly valid Claude quota
  // row, and vice versa. Promise.all here returns a single modal snapshot while
  // preserving per-provider failure boundaries for the renderer.
  const providers = await Promise.all([
    readProvider('claude', 'Claude Code Keychain', readClaudeUsage),
    readProvider('codex', '~/.codex/auth.json', readCodexUsage),
  ])

  cachedSnapshot = {
    fetchedAt: new Date(now).toISOString(),
    cache: { hit: false, ttlMs: USAGE_CACHE_TTL_MS },
    providers,
  }
  return cachedSnapshot
}
