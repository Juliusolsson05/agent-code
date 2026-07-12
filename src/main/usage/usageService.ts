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

// In-flight coalescing: the cache below only stores COMPLETED snapshots, so
// two overlapping callers would each hit the provider APIs. That overlap was
// theoretical when the modal was the only consumer, but the header indicator
// (PR #528) polls every 60s — opening the modal while a poll is in flight is
// now a routine event, and both would double-fetch Claude AND Codex. Callers
// that arrive during a fetch join the same promise instead. `force` still
// starts a fresh fetch (that's its contract) but REPLACES the in-flight
// pointer, so later joiners attach to the freshest request.
let inFlightSnapshot: Promise<UsageSnapshot> | null = null

export function getUsageSnapshot(request: UsageSnapshotRequest = {}): Promise<UsageSnapshot> {
  const now = Date.now()
  if (
    !request.force &&
    cachedSnapshot &&
    now - Date.parse(cachedSnapshot.fetchedAt) < USAGE_CACHE_TTL_MS
  ) {
    return Promise.resolve({
      ...cachedSnapshot,
      cache: { hit: true, ttlMs: USAGE_CACHE_TTL_MS },
    })
  }

  if (!request.force && inFlightSnapshot) {
    return inFlightSnapshot
  }

  const fetchPromise = (async (): Promise<UsageSnapshot> => {
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
  })()

  inFlightSnapshot = fetchPromise
  void fetchPromise.finally(() => {
    // Only clear if we're still the active fetch — a force refresh may have
    // replaced the pointer while this one was resolving.
    if (inFlightSnapshot === fetchPromise) inFlightSnapshot = null
  })
  return fetchPromise
}
