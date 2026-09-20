// Main-owned provider enablement (#1102): the single source of truth for
// "which providers may appear in pickers and usage". Renderer reaches it
// through IPC; usageService reads it in-process.

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
  loadSetupState,
  setOpencodeUsageSource as persistOpencodeUsageSource,
  setProviderEnablementOverrides,
} from '@main/setup/setupState.js'

type Listener = (snapshot: ProviderEnablementSnapshot) => void
const listeners = new Set<Listener>()

// Detection is cached for the process lifetime and only recomputed on an
// explicit reset: checkPrerequisites probes the login shell, which is slow
// enough that running it per picker render would be visible.
let cachedDetected: ReadonlySet<AgentProviderKind> | null = null
let inFlightDetection: Promise<ReadonlySet<AgentProviderKind>> | null = null
let cachedSnapshot: ProviderEnablementSnapshot | null = null

function detectInstalledKinds(): Promise<ReadonlySet<AgentProviderKind>> {
  if (cachedDetected) return Promise.resolve(cachedDetected)
  if (inFlightDetection) return inFlightDetection
  inFlightDetection = checkPrerequisites().then(result => {
    // usableProviders is the exact resolution the first-run SetupGate uses
    // (manual override → PATH probe → bundled archive), so Settings →
    // Providers and the gate can never disagree about "installed".
    cachedDetected = new Set(
      (result.usableProviders ?? []).filter(kind => AGENT_PROVIDER_KINDS.includes(kind)),
    )
    inFlightDetection = null
    return cachedDetected
  })
  return inFlightDetection
}

async function resolveAndCache(): Promise<ProviderEnablementSnapshot> {
  const state = await loadSetupState()
  const detected = await detectInstalledKinds()
  cachedSnapshot = {
    entries: resolveProviderEnablement(state.providerEnablementOverrides, detected),
    opencodeUsageSource: state.opencodeUsageSource,
  }
  return cachedSnapshot
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
  await action()
  // The usage snapshot's provider set is derived from enablement; a stale
  // 30s TTL after a toggle would show a just-hidden provider until it
  // expired. Invalidate eagerly instead.
  invalidateUsageSnapshotCache()
  const snapshot = await resolveAndCache()
  emit(snapshot)
  return snapshot
}

export async function setProviderEnabled(
  kind: AgentProviderKind,
  enabled: boolean,
): Promise<ProviderEnablementSnapshot> {
  const state = await loadSetupState()
  const overrides = { ...state.providerEnablementOverrides, [kind]: enabled }
  return await mutate(() => setProviderEnablementOverrides(overrides))
}

export async function resetProviderEnablement(
  kind: AgentProviderKind,
): Promise<ProviderEnablementSnapshot> {
  const state = await loadSetupState()
  const overrides = { ...state.providerEnablementOverrides }
  delete overrides[kind]
  // Reset must also redo detection: "installed" is the display hint on the
  // settings row, and a stale cached detection would keep showing the state
  // from before any install that happened while the app was closed.
  cachedDetected = null
  return await mutate(() => setProviderEnablementOverrides(overrides))
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
