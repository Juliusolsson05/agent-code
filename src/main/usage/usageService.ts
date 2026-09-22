import type {
  UsageProviderSnapshot,
  UsageSnapshot,
  UsageSnapshotRequest,
  UsageSourceId,
} from '@shared/types/usage.js'

import { sanitizeUsageError } from '@main/usage/normalize.js'
import { getProviderEnablementSnapshot } from '@main/setup/providerEnablement.js'
import { enabledKindsFromEntries } from '@shared/types/providerEnablement.js'
import { USAGE_SOURCES, listActiveUsageSources, listActiveUsageSourceIds } from '@main/usage/sources.js'

const USAGE_CACHE_TTL_MS = 30_000

let cachedSnapshot: UsageSnapshot | null = null
// Bumped by invalidateUsageSnapshotCache. A fetch captures the generation at
// start; if a toggle lands mid-flight, its result belongs to a stale
// enablement world and is discarded rather than written into the cache
// (review finding #4 — clearing only cachedSnapshot let a pre-toggle fetch
// resurrect a just-disabled provider for a full TTL).
let cacheGeneration = 0

async function readProvider(
  provider: UsageSourceId,
  label: string,
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
      // The label, never the raw id, in user-facing copy: "Could not load
      // z.ai usage." reads; "Could not load opencode:zai usage." does not
      // (final review #9).
      message: sanitizeUsageError(err, `Could not load ${label} usage.`),
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

  const generationAtStart = cacheGeneration
  const fetchPromise = (async (): Promise<UsageSnapshot> => {
    // WHY the sources are fetched independently:
    //
    // Sources have different auth stores, network hosts, and outage modes. A
    // stale Codex token should not hide a perfectly valid Claude quota row,
    // and vice versa. Promise.all here returns a single modal snapshot while
    // preserving per-source failure boundaries for the renderer.
    //
    // WHY composed per fetch and not cached with the snapshot: enablement can
    // change under a live cache (invalidateUsageSnapshotCache runs on every
    // toggle), and the ACTIVE SET must still be re-derived here so a fetch
    // started before a toggle cannot resurrect a disabled provider on its
    // next refresh.
    // FAIL-CLOSED for credential reads (review finding #3): the sync kind set
    // is fail-open (all four kinds) until the first enablement resolve — right
    // for pickers, wrong here, because a fetch that wins that race would send
    // a DISABLED provider's credentials to its endpoint. The spec's rule is
    // "disabled ⇒ never fetched"; awaiting the resolved snapshot guarantees it.
    const enablement = await getProviderEnablementSnapshot()
    const activeIds = listActiveUsageSourceIds({
      enabledKinds: enabledKindsFromEntries(enablement.entries),
      opencodeUsageSource: enablement.opencodeUsageSource,
    })
    const providers = await Promise.all(
      activeIds.map(id => {
        const descriptor = USAGE_SOURCES[id]
        // listActiveUsageSourceIds already excludes null descriptors; the
        // guard keeps this closure honest if that invariant ever drifts.
        if (!descriptor) return Promise.resolve(null)
        return readProvider(id, descriptor.label, descriptor.sourceLabel, descriptor.read)
      }),
    ).then(list => list.filter((entry): entry is UsageProviderSnapshot => entry !== null))

    const snapshot: UsageSnapshot = {
      fetchedAt: new Date(now).toISOString(),
      cache: { hit: false, ttlMs: USAGE_CACHE_TTL_MS },
      providers,
    }
    // A toggle landed mid-flight: this provider list is stale by construction.
    // The caller that started the fetch still gets its answer, but the cache
    // must not serve a just-disabled provider for a full TTL (finding #4).
    if (generationAtStart === cacheGeneration) cachedSnapshot = snapshot
    return snapshot
  })()

  inFlightSnapshot = fetchPromise
  void fetchPromise.finally(() => {
    // Only clear if we're still the active fetch — a force refresh may have
    // replaced the pointer while this one was resolving.
    if (inFlightSnapshot === fetchPromise) inFlightSnapshot = null
  })
  return fetchPromise
}

/** Resolved-enablement source list for the modal skeleton + empty state. */
export async function listUsageSources(): Promise<Array<{ id: UsageSourceId; label: string }>> {
  const enablement = await getProviderEnablementSnapshot()
  return listActiveUsageSources({
    enabledKinds: enabledKindsFromEntries(enablement.entries),
    opencodeUsageSource: enablement.opencodeUsageSource,
  })
}

/** Called by providerEnablement mutations (#1102): the active source set is
 * derived from enablement, so a toggle must not leave the 30s TTL serving
 * the old provider list. In-flight fetches still complete; new callers
 * fetch fresh. */
export function invalidateUsageSnapshotCache(): void {
  cacheGeneration += 1
  cachedSnapshot = null
  // Also drop the in-flight pointer (final review #4): without this, a caller
  // arriving between a toggle and the pre-toggle fetch's completion would
  // JOIN that stale promise and render the just-disabled provider once more.
  // Generation guards keep that fetch out of the cache; this keeps it out of
  // the join path too, so "new callers fetch fresh" is true again.
  inFlightSnapshot = null
}
