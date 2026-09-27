// Main-owned provider enablement (#1102): the single source of truth for
// "which providers may appear in pickers and usage". Renderer reaches it
// through IPC; usageService reads it in-process.

import { probeZaiCredential } from '@main/usage/zaiUsage.js'
import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from '@shared/types/providerKind.js'
import {
  enabledKindsFromEntries,
  resolveProviderEnablement,
  type OpencodeUsageSource,
  type ProviderEnablementSnapshot,
} from '@shared/types/providerEnablement.js'
import { checkPrerequisites } from '@main/setup/prerequisites.js'
import { invalidateUsageSnapshotCache } from '@main/usage/usageService.js'
import {
  loadDurableSetupState,
  setOpencodeUsageSource as persistOpencodeUsageSource,
  setProviderEnablementOverride,
} from '@main/setup/setupState.js'

type Listener = (snapshot: ProviderEnablementSnapshot) => void
const listeners = new Set<Listener>()

// Detection is cached for the process lifetime and only recomputed on an
// explicit reset: checkPrerequisites probes the login shell, which is slow
// enough that running it per picker render would be visible.
let cachedDetected: ReadonlySet<AgentProviderKind> | null = null
let inFlightDetection: Promise<ReadonlySet<AgentProviderKind>> | null = null
let cachedSnapshot: ProviderEnablementSnapshot | null = null
// The last detection that succeeded, kept across a reset (which clears
// `cachedDetected` to force a fresh probe). It is what a saved change is
// shown against when the fresh probe fails; see `mutate`.
let lastDetected: ReadonlySet<AgentProviderKind> | null = null

function detectInstalledKinds(): Promise<ReadonlySet<AgentProviderKind>> {
  if (cachedDetected) return Promise.resolve(cachedDetected)
  if (inFlightDetection) return inFlightDetection
  inFlightDetection = checkPrerequisites()
    .then(result => {
      // usableProviders is the exact resolution the first-run SetupGate uses
      // (manual override → PATH probe → bundled archive), so Settings →
      // Providers and the gate can never disagree about "installed".
      cachedDetected = new Set(
        (result.usableProviders ?? []).filter(kind => AGENT_PROVIDER_KINDS.includes(kind)),
      )
      lastDetected = cachedDetected
      return cachedDetected
    })
    // WHY in `finally` (#1403 review): cleared only on success, a rejected
    // probe stayed in flight forever, so every later resolve returned the
    // same rejection until restart.
    .finally(() => {
      inFlightDetection = null
    })
  return inFlightDetection
}

// WHY refreshes are ordered (#1403 verification a): a refresh reads setup
// state, then awaits detection and the credential probe. Two rows can write
// at once (each disables only its own switch), so an OLDER refresh could
// finish last and overwrite, and broadcast, a snapshot built before the newer
// write: the user disables Claude, disk says disabled, and pickers show it
// enabled until some later refresh. Only a refresh started after the one
// already applied may replace it; a stale one answers with the newer snapshot.
let refreshesStarted = 0
let appliedRefresh = 0

async function resolveAndCache(
  detection: () => Promise<ReadonlySet<AgentProviderKind>> = detectInstalledKinds,
): Promise<ProviderEnablementSnapshot> {
  const refresh = ++refreshesStarted
  // DURABLE state, not the optimistic cache (#1403 recheck b): two toggles in
  // flight, the first saves and refreshes while the second is still pending,
  // and the cache already holds the second. The second then failed to write,
  // and its row said "Nothing was changed" while this refresh had broadcast
  // it. Every refresh here runs after its own write landed, so the durable
  // state already includes everything it needs to show.
  const state = await loadDurableSetupState()
  const detected = await detection()
  const next: ProviderEnablementSnapshot = {
    entries: resolveProviderEnablement(state.providerEnablementOverrides, detected),
    opencodeUsageSource: state.opencodeUsageSource,
    zaiCredentialPresent: await probeZaiCredential(),
  }
  if (refresh < appliedRefresh && cachedSnapshot) return cachedSnapshot
  appliedRefresh = refresh
  cachedSnapshot = next
  return next
}

/** Fail-open before the first resolve: hiding a user's providers because a
 * poll had not run yet is worse than briefly showing a provider that was
 * just disabled — and matches pre-#1102 behavior exactly. */
export function enabledAgentProviderKindsSync(): ReadonlySet<AgentProviderKind> {
  return cachedSnapshot
    ? enabledKindsFromEntries(cachedSnapshot.entries)
    : new Set(AGENT_PROVIDER_KINDS)
}

export function getCachedProviderEnablement(): ProviderEnablementSnapshot | null {
  return cachedSnapshot
}

export async function getProviderEnablementSnapshot(): Promise<ProviderEnablementSnapshot> {
  return await resolveAndCache()
}

function emit(snapshot: ProviderEnablementSnapshot): void {
  for (const listener of listeners) listener(snapshot)
}

async function mutate(action: () => Promise<unknown>): Promise<ProviderEnablementSnapshot> {
  // A rejection here is a change that was NOT saved; the renderer says so.
  await action()
  // WHY a refresh failure no longer rejects (#1403 review a and b): once the
  // write landed, the change IS saved and takes effect. Rejecting made the row
  // say "Nothing was changed" about a change that was on disk (a reset clears
  // detection first, so a failing re-probe hit this directly). Show the saved
  // state against the last detection that succeeded, or fail open to "all
  // installed" before any has, the same fail-open as
  // `enabledAgentProviderKindsSync`. The next resolve probes again.
  let snapshot: ProviderEnablementSnapshot
  try {
    snapshot = await resolveAndCache()
  } catch (error) {
    console.warn('[provider-enablement] saved, but re-detecting providers failed:', error)
    const fallback = lastDetected ?? new Set(AGENT_PROVIDER_KINDS)
    snapshot = await resolveAndCache(async () => fallback)
  }
  // Resolve the NEW enablement BEFORE invalidating the usage cache (review
  // finding #4): the old order invalidated first, so a usage fetch landing
  // in that window recomposed from the PREVIOUS snapshot and re-cached the
  // just-disabled provider. Generation-guarded cache writes cover the fetch
  // already in flight; this closes the window for the next one.
  invalidateUsageSnapshotCache()
  emit(snapshot)
  return snapshot
}

export async function setProviderEnabled(
  kind: AgentProviderKind,
  enabled: boolean,
): Promise<ProviderEnablementSnapshot> {
  return await mutate(() => setProviderEnablementOverride(kind, enabled))
}

export async function resetProviderEnablement(
  kind: AgentProviderKind,
): Promise<ProviderEnablementSnapshot> {
  // Reset must also redo detection: "installed" is the display hint on the
  // settings row, and a stale cached detection would keep showing the state
  // from before any install that happened while the app was closed.
  cachedDetected = null
  return await mutate(() => setProviderEnablementOverride(kind, null))
}

export async function setOpencodeUsage(
  value: OpencodeUsageSource,
): Promise<ProviderEnablementSnapshot> {
  return await mutate(() => persistOpencodeUsageSource(value))
}

export function onProviderEnablementChanged(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
