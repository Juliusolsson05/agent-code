import type { ChildProcess, spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import type { MockedFunction } from 'vitest'

export type HeldSpawn = { child?: ChildProcess; readyAt?: number }

/**
 * Let the next call to a mocked `spawn` start the real child, but return it only
 * once that child has reported readiness (or `budgetMs` has passed).
 *
 * WHY: runOpencode arms its deadline, its size guard and its abort handling only
 * after spawn() returns. A test that waits for readiness while those bounds are
 * already running makes readiness compete with them. On a heavily loaded machine
 * (which is how this was found: a stop case failed before stop() ever ran) Node
 * can take longer to start a child than a 1 s deadline or a 2 s readiness wait.
 * A correct deadline then kills the child before it reports, or the wait gives
 * up first. Neither failure says anything about termination.
 *
 * Holding the synchronous spawn call makes readiness a precondition of every
 * bound, so the bounds that ARE the contract stay tight instead of being
 * widened. Atomics.wait is the only synchronous sleep available; the child keeps
 * running while this worker waits.
 *
 * `child` is filled at spawn time, so the test owns the child even when
 * readiness never arrives. When the budget runs out, spawn returns anyway and
 * the caller's readiness assertion reports it.
 */
export function holdNextSpawnUntilReady(
  mockedSpawn: MockedFunction<typeof spawn>,
  realSpawn: typeof spawn,
  isReady: () => boolean,
  budgetMs: number,
): HeldSpawn {
  const held: HeldSpawn = {}
  mockedSpawn.mockImplementationOnce(((...args: Parameters<typeof realSpawn>) => {
    const child = realSpawn(...args)
    held.child = child
    const readyBy = performance.now() + budgetMs
    const pause = new Int32Array(new SharedArrayBuffer(4))
    while (!isReady() && performance.now() < readyBy) Atomics.wait(pause, 0, 0, 10)
    held.readyAt = performance.now()
    return child
  }) as typeof spawn)
  return held
}
