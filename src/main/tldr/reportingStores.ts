import { join } from 'node:path'
import { TldrStore } from './TldrStore.js'

/**
 * The TLDR and Goal stores, as the app runs them.
 *
 * WHY a factory and not two lines in index.ts (#1328 round 2 c): which
 * identities a store may evict at its cap is decided by the `inUse` callback
 * passed here, and a store built without one evicts by age alone, which is
 * the bug that let a running agent's goal disappear. As two constructor
 * calls in index.ts nothing tested that wiring. Here `inUse` is a required
 * parameter the test drives, and both stores must receive it.
 */
export function createReportingStores(
  stateDirectory: string,
  inUse: () => ReadonlySet<string> | null,
): { tldrStore: TldrStore; goalStore: TldrStore } {
  return {
    tldrStore: new TldrStore(join(stateDirectory, 'tldr.json'), undefined, { inUse }),
    goalStore: new TldrStore(join(stateDirectory, 'goal.json'), undefined, { historyDirectoryName: 'goal-history', label: 'Goal', inUse }),
  }
}
