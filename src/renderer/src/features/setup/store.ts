import { useMemo } from 'react'
import { create } from 'zustand'

import { AGENT_PROVIDER_KINDS, DEFAULT_PROVIDER, type AgentProviderKind } from '@shared/types/providerKind'
import type { SetupCheckResult } from '@shared/types/setup'

/**
 * The renderer's one copy of the setup check (#995).
 *
 * WHY a store instead of the gate's local state (which is what it was):
 * - Three surfaces need the same answer. The gate shows it, the fresh-install
 *   bootstrap picks the first project's kind from it, and the provider pickers
 *   mark missing CLIs with it. Each calling `setupCheck()` itself would run
 *   three rounds of login-shell probes at launch, and could get three
 *   different answers if the user installs a CLI mid-launch.
 * - The gate must be REOPENABLE. The spawn error said "open Setup to locate
 *   it", but Setup was a local `dismissed` flag inside a component mounted
 *   once, with no way back after launch. `requested` is the reopen.
 */
type SetupStore = {
  check: SetupCheckResult | null
  error: string | null
  /** The user opened Setup (command or File menu). Shows the panel even
   *  when nothing is missing, and closes on Escape. */
  requested: boolean
  /** The automatic first-run panel was answered for this run. */
  dismissed: boolean
  /**
   * A fresh-install bootstrap is parked on this panel's answer.
   *
   * WHY the panel needs to know (#1047 review): "Continue with a terminal"
   * promises something only the waiting bootstrap can deliver. A returning
   * user with a restored workspace, or a panel the user opened whose re-probe
   * happens to find no provider, would read that label and get a dismissal.
   */
  firstRunWaiting: boolean
  setCheck: (check: SetupCheckResult) => void
  setError: (error: string | null) => void
  open: () => void
  close: () => void
}

export const useSetupStore = create<SetupStore>(set => ({
  check: null,
  error: null,
  requested: false,
  dismissed: false,
  firstRunWaiting: false,
  setCheck: check => set({ check, error: null }),
  setError: error => set({ error }),
  open: () => set({ requested: true }),
  // Closing a requested panel also answers the automatic one: a user who
  // opened Setup, read it and closed it has seen everything the automatic
  // panel would say.
  close: () => set({ requested: false, dismissed: true }),
}))

let inFlight: Promise<SetupCheckResult | null> | null = null

/**
 * Runs the check, sharing one in-flight probe among all callers.
 *
 * Resolves null when the check itself failed (IPC error). That is
 * "unknown", never "nothing installed": callers fall back to the behavior
 * before #995 rather than treat a broken probe as an empty machine.
 */
export function refreshSetupCheck(): Promise<SetupCheckResult | null> {
  if (inFlight) return inFlight
  const store = useSetupStore.getState()
  // Through a resolved promise so a missing or throwing IPC surface (an older
  // preload, a test stub) lands in the catch below instead of throwing out of
  // bootstrap synchronously.
  inFlight = Promise.resolve()
    .then(() => window.api.setupCheck())
    .then(check => { store.setCheck(check); return check })
    .catch((err: unknown) => {
      store.setError(err instanceof Error ? err.message : String(err))
      return null
    })
    .finally(() => { inFlight = null })
  return inFlight
}

/** The cached check, or the in-flight one, or a new one. */
export function ensureSetupCheck(): Promise<SetupCheckResult | null> {
  const { check } = useSetupStore.getState()
  return check ? Promise.resolve(check) : refreshSetupCheck()
}

/**
 * What the fresh-install bootstrap may open its first project with.
 *
 * WHY bootstrap waits here (#995 finding 3): it used to spawn Claude the
 * moment it mounted, underneath the gate that was telling the user Claude
 * was missing. The spawn failed and left no tabs, which also kept autosave
 * off for the run. Now:
 * - With a usable provider, this resolves at once and nothing waits.
 * - With none, the automatic panel is up, and this resolves when the user
 *   answers it. Either they install a CLI and press Retry (the check then
 *   has a provider, so the first project is an agent), or they choose
 *   "Continue with a terminal".
 * - A failed check resolves null at once. Never hold the workspace hostage
 *   to a probe.
 */
export async function awaitFirstRunDecision(): Promise<SetupCheckResult | null> {
  const first = await ensureSetupCheck()
  if (!first) return null
  if (first.usableProviders.length > 0 || useSetupStore.getState().dismissed) return first
  useSetupStore.setState({ firstRunWaiting: true })
  return await new Promise(resolve => {
    const unsubscribe = useSetupStore.subscribe(state => {
      const decided = state.dismissed || (state.check?.usableProviders.length ?? 0) > 0
      if (!decided) return
      settleFirstRunWaiter(state.check)
    })
    // Held at module scope so resetSetupStoreForTests can settle a parked
    // waiter (#995 Codex review). Without it a waiter from one test outlived
    // the reset, unsubscribed from nothing, and resolved on the NEXT test's
    // first check — spawning a second project there.
    settleFirstRunWaiter = check => {
      unsubscribe()
      settleFirstRunWaiter = () => undefined
      useSetupStore.setState({ firstRunWaiting: false })
      resolve(check ?? null)
    }
  })
}

let settleFirstRunWaiter: (check: SetupCheckResult | null | undefined) => void = () => undefined

/**
 * Providers the last check did not find, for the pickers' "not installed"
 * hint (#995 finding 6: the failure used to surface only after the user had
 * already chosen a directory).
 *
 * WHY a hint and never a disabled row: the probe can be wrong (#495 A1, an
 * exotic shell or a Finder PATH), and a spawn does its own late re-resolve.
 * A disabled row would turn a probe false-negative back into a lockout, which
 * is the thing #995 removes. Empty until a check exists, so nothing is ever
 * marked missing on a guess.
 */
export function useMissingProviders(): ReadonlySet<AgentProviderKind> {
  const usable = useSetupStore(state => state.check?.usableProviders)
  return useMemo(
    () => new Set(usable ? AGENT_PROVIDER_KINDS.filter(kind => !usable.includes(kind)) : []),
    [usable],
  )
}

/** The provider a picker should preselect: the first-run choice when it is a
 *  provider, otherwise the default. Read once when a picker opens. */
export function preferredPickerProvider(): AgentProviderKind {
  const kind = useSetupStore.getState().check?.firstSessionKind
  return kind && kind !== 'terminal' ? kind : DEFAULT_PROVIDER
}

/** Hint shown beside a provider the last check did not find. */
export const MISSING_PROVIDER_HINT = 'Not installed · File › Setup…'

/** Test seam: the module-level in-flight promise outlives a store reset. */
export function resetSetupStoreForTests(): void {
  inFlight = null
  settleFirstRunWaiter(null)
  useSetupStore.setState({ check: null, error: null, requested: false, dismissed: false, firstRunWaiting: false })
}
